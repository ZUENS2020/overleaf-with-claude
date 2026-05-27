#!/usr/bin/env node
'use strict'

const { Command } = require('commander')
const chalk = require('chalk')
const ora = require('ora')
const fs = require('fs')
const path = require('path')
const { spawnSync, spawn } = require('child_process')

const { compose, composeStream, requireRoot, findRepoRoot, developDir, saveRc, REPO_URL } = require('../lib/compose')
const { configWizard, readEnv, writeEnv } = require('../lib/env')
const { runDiagnose } = require('../lib/diagnose')

const program = new Command()
program.name('olc').description('Overleaf + Claude CLI').version('1.0.0')

// ─── install ────────────────────────────────────────────────────────────────

program
  .command('install')
  .description('Clone, configure, build and start (first-time setup)')
  .option('-d, --dir <path>', 'install directory', './overleaf-claude')
  .option('--skip-build', 'skip docker image build (use cached images)')
  .action(async (opts) => {
    const inquirer = require('inquirer')

    // 1. Check prerequisites
    const spinner = ora('Checking prerequisites').start()
    for (const bin of ['docker', 'git']) {
      const r = spawnSync(bin, ['--version'], { stdio: 'pipe' })
      if (r.status !== 0) {
        spinner.fail(`${bin} not found — please install it first`)
        process.exit(1)
      }
    }
    const compose = spawnSync('docker', ['compose', 'version'], { stdio: 'pipe' })
    if (compose.status !== 0) {
      spinner.fail('docker compose not found — please install Docker Desktop or the Compose plugin')
      process.exit(1)
    }
    spinner.succeed('Prerequisites OK')

    // 2. Resolve install dir
    const { dir: rawDir } = await inquirer.prompt([{
      name: 'dir', type: 'input',
      message: 'Install directory:',
      default: opts.dir,
    }])
    const installDir = path.resolve(rawDir)

    // 3. Clone or use existing
    if (fs.existsSync(path.join(installDir, 'develop', 'docker-compose.yml'))) {
      console.log(chalk.gray(`  Repo already at ${installDir}, skipping clone`))
    } else {
      const cloneSpinner = ora(`Cloning into ${installDir}`).start()
      const r = spawnSync('git', ['clone', REPO_URL, installDir], { stdio: 'pipe' })
      if (r.status !== 0) {
        cloneSpinner.fail('git clone failed:\n' + r.stderr?.toString())
        process.exit(1)
      }
      cloneSpinner.succeed('Cloned')
    }

    saveRc(installDir)

    // 4. Create required directories
    const devDir = path.join(installDir, 'develop')
    for (const d of ['compiles', 'output', 'webpack-output', 'nginx']) {
      fs.mkdirSync(path.join(devDir, d), { recursive: true })
    }

    // Copy nginx.conf if missing
    const nginxSrc = path.join(installDir, 'develop', 'nginx', 'nginx.conf')
    if (!fs.existsSync(nginxSrc)) {
      const defaultNginx = `resolver 127.0.0.11 valid=10s ipv6=off;

server {
    listen 80;

    location /socket.io/ {
        set $realtime_host real-time;
        proxy_pass http://$realtime_host:3026;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ~ ^/project/[^/]+/ai-assistant/stream {
        set $web_host web;
        proxy_pass http://$web_host:3000;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        set $web_host web;
        proxy_pass http://$web_host:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`
      fs.writeFileSync(nginxSrc, defaultNginx)
    }

    // 5. Configure dev.env
    await configWizard(installDir)

    // 6. Build images
    if (!opts.skipBuild) {
      console.log(chalk.cyan('\nBuilding Docker images (this takes a while on first run)...\n'))
      const buildResult = spawnSync('docker', ['compose', 'build'], {
        cwd: devDir, stdio: 'inherit', env: process.env,
      })
      if (buildResult.status !== 0) {
        console.error(chalk.red('Build failed. Fix errors above and re-run `olc install --skip-build` to skip rebuild.'))
        process.exit(1)
      }
    }

    // 7. Build webpack
    await buildFrontend(installDir)

    // 8. Start services
    console.log(chalk.cyan('\nStarting services...\n'))
    const up = spawnSync('docker', ['compose', 'up', '--detach'], {
      cwd: devDir, stdio: 'inherit', env: process.env,
    })
    if (up.status !== 0) {
      console.error(chalk.red('Failed to start services.'))
      process.exit(1)
    }

    // 9. Wait for web
    const env = readEnv(installDir)
    const baseUrl = env['PUBLIC_URL'] || 'http://localhost:8082'
    await waitForWeb(baseUrl)

    console.log(chalk.green.bold(`\n✓ Overleaf + Claude is running at ${baseUrl}`))
    console.log(chalk.gray(`  First-time setup: open ${baseUrl}/launchpad to create admin account\n`))
  })

// ─── start ──────────────────────────────────────────────────────────────────

program
  .command('start [services...]')
  .description('Start services (docker compose up)')
  .action((services) => {
    const root = requireRoot()
    const devDir = developDir(root)
    fs.mkdirSync(path.join(devDir, 'output'), { recursive: true })
    fs.mkdirSync(path.join(devDir, 'compiles'), { recursive: true })
    const args = ['compose', 'up', '--detach', ...services]
    spawnSync('docker', args, { cwd: devDir, stdio: 'inherit', env: process.env })
  })

// ─── stop ───────────────────────────────────────────────────────────────────

program
  .command('stop')
  .description('Stop all services (docker compose down)')
  .option('-v, --volumes', 'also remove volumes')
  .action((opts) => {
    const root = requireRoot()
    const args = opts.volumes ? ['compose', 'down', '-v'] : ['compose', 'down']
    spawnSync('docker', args, { cwd: developDir(root), stdio: 'inherit', env: process.env })
  })

// ─── restart ────────────────────────────────────────────────────────────────

program
  .command('restart [services...]')
  .description('Restart one or more services')
  .action((services) => {
    const root = requireRoot()
    const target = services.length ? services : []
    spawnSync('docker', ['compose', 'restart', ...target], {
      cwd: developDir(root), stdio: 'inherit', env: process.env,
    })
  })

// ─── logs ───────────────────────────────────────────────────────────────────

program
  .command('logs [service]')
  .description('Follow logs (all services or one)')
  .option('-n, --lines <n>', 'last N lines', '50')
  .action((service, opts) => {
    const root = requireRoot()
    const args = ['compose', 'logs', '--follow', '--tail', opts.lines]
    if (service) args.push(service)
    const proc = spawn('docker', args, { cwd: developDir(root), stdio: 'inherit', env: process.env })
    proc.on('close', code => process.exit(code || 0))
  })

// ─── config ─────────────────────────────────────────────────────────────────

program
  .command('config')
  .description('Reconfigure dev.env interactively')
  .option('--all', 'prompt for all fields, not just empty ones')
  .action(async (opts) => {
    const root = requireRoot()
    await configWizard(root, opts.all)
    console.log(chalk.gray('Restart services to apply: olc restart'))
  })

// ─── diagnose ───────────────────────────────────────────────────────────────

program
  .command('diagnose')
  .description('Health checks: containers, nginx SSE, AI assistant, env')
  .action(async () => {
    const root = requireRoot()
    await runDiagnose(root)
  })

// ─── update ─────────────────────────────────────────────────────────────────

program
  .command('update')
  .description('Pull latest code and redeploy changed parts')
  .option('--no-frontend', 'skip frontend rebuild')
  .action(async (opts) => {
    const root = requireRoot()

    // git pull
    const pullSpinner = ora('Pulling latest code').start()
    const pull = spawnSync('git', ['pull', '--ff-only'], { cwd: root, stdio: 'pipe', encoding: 'utf8' })
    if (pull.status !== 0) {
      pullSpinner.fail(pull.stderr?.trim() || 'git pull failed')
      process.exit(1)
    }
    if (pull.stdout?.includes('Already up to date')) {
      pullSpinner.succeed('Already up to date')
      return
    }
    pullSpinner.succeed(`Updated: ${pull.stdout?.trim()}`)

    // What changed?
    const diff = spawnSync('git', ['diff', 'HEAD@{1}..HEAD', '--name-only'], {
      cwd: root, stdio: 'pipe', encoding: 'utf8',
    })
    const changed = (diff.stdout || '').split('\n').filter(Boolean)
    console.log(chalk.gray(`  Changed files: ${changed.length}`))

    const frontendChanged = changed.some(f => f.startsWith('services/web/frontend/') || f.startsWith('services/web/app/src/'))
    const webBackendChanged = changed.some(f => f.startsWith('services/web/app/') || f.startsWith('services/web/config/'))
    const nginxChanged = changed.some(f => f.includes('nginx/nginx.conf'))

    const serviceDockerfiles = ['chat','clsi','contacts','docstore','document-updater',
      'filestore','history-v1','notifications','project-history','real-time','web']
    const rebuiltServices = serviceDockerfiles.filter(svc =>
      changed.some(f => f.includes(`services/${svc}/Dockerfile`) || f.includes(`libraries/`))
    )

    // Rebuild docker images if Dockerfiles changed
    if (rebuiltServices.length) {
      console.log(chalk.cyan(`\nRebuilding images: ${rebuiltServices.join(', ')}`))
      spawnSync('docker', ['compose', 'build', ...rebuiltServices], {
        cwd: developDir(root), stdio: 'inherit', env: process.env,
      })
    }

    // Rebuild frontend if needed
    if (opts.frontend && frontendChanged) {
      await buildFrontend(root)
    }

    // Reload nginx config
    if (nginxChanged) {
      const nginxSpinner = ora('Reloading nginx').start()
      const containers = spawnSync('docker', ['ps', '--filter', 'name=nginx', '--format', '{{.Names}}'],
        { stdio: 'pipe', encoding: 'utf8' })
      const nginxContainer = (containers.stdout || '').split('\n')
        .find(n => n.includes('nginx') && !n.includes('clsi'))?.trim()
      if (nginxContainer) {
        spawnSync('docker', ['exec', nginxContainer, 'nginx', '-s', 'reload'], { stdio: 'pipe' })
        nginxSpinner.succeed(`nginx reloaded (${nginxContainer})`)
      } else {
        nginxSpinner.warn('nginx container not found')
      }
    }

    // Restart affected services
    const toRestart = new Set(rebuiltServices)
    if (webBackendChanged && !rebuiltServices.includes('web')) toRestart.add('web')
    if (nginxChanged) toRestart.add('nginx')

    if (toRestart.size) {
      console.log(chalk.cyan(`\nRestarting: ${[...toRestart].join(', ')}`))
      spawnSync('docker', ['compose', 'restart', ...[...toRestart]], {
        cwd: developDir(root), stdio: 'inherit', env: process.env,
      })
    }

    console.log(chalk.green('\n✓ Update complete\n'))
  })

// ─── build-frontend ─────────────────────────────────────────────────────────

program
  .command('build-frontend')
  .description('Rebuild webpack bundle and restart web')
  .action(async () => {
    const root = requireRoot()
    await buildFrontend(root)
    const webRestartSpinner = ora('Restarting web').start()
    spawnSync('docker', ['compose', 'restart', 'web'], {
      cwd: developDir(root), stdio: 'pipe', env: process.env,
    })
    webRestartSpinner.succeed('web restarted')
  })

// ─── fix-nginx ──────────────────────────────────────────────────────────────

program
  .command('fix-nginx')
  .description('Apply SSE proxy_buffering fix to nginx config and reload')
  .action(() => {
    const root = requireRoot()
    const nginxConf = path.join(developDir(root), 'nginx', 'nginx.conf')

    fs.mkdirSync(path.dirname(nginxConf), { recursive: true })

    if (!fs.existsSync(nginxConf) || !fs.readFileSync(nginxConf, 'utf8').includes('ai-assistant/stream')) {
      // Rewrite with SSE block
      const current = fs.existsSync(nginxConf) ? fs.readFileSync(nginxConf, 'utf8') : ''
      const sseBlock = `
    # SSE: disable buffering so events reach the browser immediately.
    location ~ ^/project/[^/]+/ai-assistant/stream {
        set $web_host web;
        proxy_pass http://$web_host:3000;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {`
      const patched = current.replace(/\n    location \/ {/, sseBlock)
      if (patched === current) {
        console.log(chalk.yellow('Could not patch automatically — please add the SSE block to nginx/nginx.conf manually'))
        return
      }
      fs.writeFileSync(nginxConf, patched)
      console.log(chalk.green('✓ nginx.conf patched'))
    } else {
      console.log(chalk.gray('nginx.conf already has SSE location block'))
    }

    // Reload nginx
    const devDir = developDir(root)
    const ps = spawnSync('docker', ['compose', 'ps', '--format', 'json', 'nginx'],
      { cwd: devDir, stdio: 'pipe', encoding: 'utf8' })
    const nginxRunning = ps.stdout?.includes('"nginx"') || ps.stdout?.includes('running')
    if (nginxRunning) {
      const { status } = spawnSync('docker', ['compose', 'exec', 'nginx', 'nginx', '-s', 'reload'],
        { cwd: devDir, stdio: 'pipe' })
      if (status === 0) console.log(chalk.green('✓ nginx reloaded'))
      else console.log(chalk.yellow('nginx reload failed — try `olc restart nginx`'))
    } else {
      console.log(chalk.gray('nginx not running — start with `olc start`'))
    }
  })

// ─── helpers ────────────────────────────────────────────────────────────────

async function buildFrontend(root) {
  const spinner = ora('Building frontend (webpack)').start()
  const devDir = developDir(root)

  // Find the webpack image
  const images = spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'],
    { stdio: 'pipe', encoding: 'utf8' })
  const webpackImage = (images.stdout || '').split('\n')
    .find(l => l.includes('webpack'))?.trim()

  if (!webpackImage) {
    spinner.warn('webpack image not found — skipping frontend build (run `olc install` to build images)')
    return
  }

  const bind = (src, dst) => `-v${path.join(root, src)}:/overleaf/${src}`
  const outputBind = `${path.join(devDir, 'webpack-output')}:/overleaf/services/web/public`

  const r = spawnSync('docker', [
    'run', '--rm',
    bind('services/web/frontend', 'services/web/frontend'),
    bind('services/web/app/src', 'services/web/app/src'),
    bind('services/web/locales', 'services/web/locales'),
    `-v`, outputBind,
    webpackImage,
    'npx', 'webpack', '--config', 'webpack.config.prod.js',
  ], { stdio: 'pipe', encoding: 'utf8', env: process.env })

  if (r.status !== 0) {
    spinner.fail('webpack build failed:\n' + (r.stderr || r.stdout || '').slice(0, 500))
    throw new Error('webpack build failed')
  }
  spinner.succeed('Frontend built')
}

function waitForWeb(baseUrl, timeoutMs = 120000) {
  const http = require('http')
  const https = require('https')
  const lib = baseUrl.startsWith('https') ? https : http
  const spinner = ora(`Waiting for ${baseUrl}`).start()
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    function attempt() {
      if (Date.now() > deadline) {
        spinner.warn('Timed out waiting for web service — it may still be starting')
        resolve()
        return
      }
      const req = lib.get(baseUrl + '/login', { timeout: 5000 }, res => {
        res.resume()
        if (res.statusCode < 500) {
          spinner.succeed(`Web service ready (HTTP ${res.statusCode})`)
          resolve()
        } else {
          setTimeout(attempt, 3000)
        }
      })
      req.on('error', () => setTimeout(attempt, 3000))
      req.on('timeout', () => { req.destroy(); setTimeout(attempt, 3000) })
    }
    attempt()
  })
}

program.parse(process.argv)
