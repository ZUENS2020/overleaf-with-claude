'use strict'

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')

const { developDir, getRunningContainers, SERVICES } = require('./compose')
const { readEnv } = require('./env')

function check(label, pass, detail = '') {
  const chalk = require('chalk')
  const icon = pass ? chalk.green('✓') : chalk.red('✗')
  const msg = pass ? chalk.green(label) : chalk.red(label)
  console.log(`  ${icon} ${msg}${detail ? chalk.gray('  ' + detail) : ''}`)
  return pass
}

function warn(label, detail = '') {
  const chalk = require('chalk')
  console.log(`  ${chalk.yellow('!')} ${chalk.yellow(label)}${detail ? chalk.gray('  ' + detail) : ''}`)
}

function httpGet(url, timeoutMs = 5000) {
  return new Promise(resolve => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, { timeout: timeoutMs }, res => {
      res.resume()
      resolve({ ok: true, status: res.statusCode })
    })
    req.on('error', err => resolve({ ok: false, error: err.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }) })
  })
}

function dockerExec(containerName, cmd) {
  return spawnSync('docker', ['exec', containerName, ...cmd.split(' ')], {
    stdio: 'pipe',
    encoding: 'utf8',
  })
}

async function runDiagnose(root) {
  const chalk = require('chalk')
  let passed = 0
  let failed = 0

  function record(ok) { ok ? passed++ : failed++ }

  // --- Prerequisites ---
  console.log(chalk.bold('\n[ Prerequisites ]'))
  {
    const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe', encoding: 'utf8' })
    record(check('Docker installed', docker.status === 0, docker.stdout?.trim()))
    const compose = spawnSync('docker', ['compose', 'version', '--short'], { stdio: 'pipe', encoding: 'utf8' })
    record(check('Docker Compose installed', compose.status === 0, compose.stdout?.trim()))
  }

  // --- dev.env ---
  console.log(chalk.bold('\n[ Configuration ]'))
  const env = readEnv(root)
  {
    const key = env['AI_ASSISTANT_TOKEN_KEY'] || ''
    record(check('AI_ASSISTANT_TOKEN_KEY set', /^[0-9a-f]{64}$/i.test(key),
      key ? (key.length === 64 ? '64-char hex ✓' : `length=${key.length}, expected 64`) : 'empty — run `olc config`'))
    record(check('AI_ASSISTANT_CLAUDE_BIN set', !!env['AI_ASSISTANT_CLAUDE_BIN'], env['AI_ASSISTANT_CLAUDE_BIN'] || 'not set'))
    record(check('SESSION_SECRET set', !!env['SESSION_SECRET']))
    const pub = env['PUBLIC_URL']
    record(check('PUBLIC_URL set', !!pub, pub || 'not set'))
  }

  // --- Containers ---
  console.log(chalk.bold('\n[ Containers ]'))
  const devDir = developDir(root)
  const projectName = path.basename(root).replace(/[^a-z0-9]/gi, '').toLowerCase()
  const containers = getRunningContainers(root)
  const runningNames = new Set(containers.map(c => c.Name || c.Service || ''))
  const runningServices = new Set(containers.map(c => (c.Service || '')))

  const criticalServices = ['web', 'nginx', 'mongo', 'redis', 'real-time', 'clsi']
  for (const svc of criticalServices) {
    const running = runningServices.has(svc) ||
      containers.some(c => (c.Name || '').includes(`-${svc}-`))
    const state = containers.find(c => (c.Name || c.Service || '').includes(svc))
    const status = state?.State || state?.Status || ''
    record(check(`${svc} running`, running, running ? status : 'not found'))
  }
  const otherServices = SERVICES.filter(s => !criticalServices.includes(s))
  let allOthersUp = true
  for (const svc of otherServices) {
    const running = runningServices.has(svc) ||
      containers.some(c => (c.Name || '').includes(`-${svc}-`))
    if (!running) allOthersUp = false
  }
  record(check('All other services running', allOthersUp,
    allOthersUp ? '' : otherServices.filter(s => !runningServices.has(s)).join(', ') + ' not running'))

  // --- nginx SSE config ---
  console.log(chalk.bold('\n[ nginx SSE ]'))
  {
    const nginxConf = path.join(devDir, 'nginx', 'nginx.conf')
    const exists = fs.existsSync(nginxConf)
    record(check('nginx/nginx.conf exists', exists, nginxConf))
    if (exists) {
      const content = fs.readFileSync(nginxConf, 'utf8')
      const hasSSEBlock = content.includes('ai-assistant/stream')
      const hasBufferingOff = content.includes('proxy_buffering off')
      const hasTimeout = content.includes('proxy_read_timeout')
      record(check('SSE location block present', hasSSEBlock))
      record(check('proxy_buffering off', hasBufferingOff,
        hasBufferingOff ? '' : 'SSE events will be buffered — run `olc fix-nginx`'))
      if (!hasTimeout) warn('proxy_read_timeout not set (long SSE connections may drop)')
    }
  }

  // --- Web service ---
  console.log(chalk.bold('\n[ Web service ]'))
  {
    const pub = env['PUBLIC_URL'] || 'http://localhost:8082'
    const loginUrl = pub.replace(/\/$/, '') + '/login'
    process.stdout.write(`  Checking ${loginUrl} ... `)
    const result = await httpGet(loginUrl)
    const ok = result.ok && result.status < 500
    console.log(ok ? chalk.green(`HTTP ${result.status}`) : chalk.red(result.error || `HTTP ${result.status}`))
    record(ok)

    // Check X-Accel-Buffering header
    const ctrlFile = path.join(root, 'services/web/app/src/Features/AiAssistant/AiAssistantController.mjs')
    if (fs.existsSync(ctrlFile)) {
      const src = fs.readFileSync(ctrlFile, 'utf8')
      const hasHeader = src.includes('x-accel-buffering')
      record(check('X-Accel-Buffering header in controller', hasHeader,
        hasHeader ? '' : 'SSE buffering fallback missing — run `olc fix-nginx`'))
    }

    // IME fix
    const paneFile = path.join(root, 'services/web/frontend/js/features/ai-assistant/components/ai-assistant-pane.tsx')
    if (fs.existsSync(paneFile)) {
      const src = fs.readFileSync(paneFile, 'utf8')
      const hasImeFix = src.includes('isComposing')
      record(check('IME composition fix (isComposing)', hasImeFix,
        hasImeFix ? '' : 'Chinese IME Enter sends message early — needs frontend rebuild'))
    }
  }

  // --- Claude CLI ---
  console.log(chalk.bold('\n[ Claude CLI ]'))
  {
    const webContainer = containers.find(c => (c.Service || '') === 'web' ||
      (c.Name || '').match(/-web-\d+$/))
    if (webContainer) {
      const cname = webContainer.Name
      const claudeBin = env['AI_ASSISTANT_CLAUDE_BIN'] || 'claude'
      const r = dockerExec(cname, `${claudeBin} --version`)
      const ok = r.status === 0
      record(check('claude CLI in web container', ok,
        ok ? r.stdout?.trim() : (r.stderr?.trim() || 'not found')))
    } else {
      warn('web container not running — cannot check claude CLI')
    }
  }

  // --- Summary ---
  console.log()
  if (failed === 0) {
    console.log(chalk.green.bold(`All ${passed} checks passed ✓`))
  } else {
    console.log(chalk.yellow(`${passed} passed, `) + chalk.red.bold(`${failed} failed`))
    console.log(chalk.gray('Run `olc fix-nginx` to apply SSE fixes, `olc config` to reconfigure.'))
  }
  console.log()
  return failed === 0
}

module.exports = { runDiagnose }
