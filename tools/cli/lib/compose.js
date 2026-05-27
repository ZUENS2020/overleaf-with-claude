'use strict'

const { spawnSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const RC_FILE = path.join(os.homedir(), '.olcrc')
const REPO_URL = 'https://github.com/ZUENS2020/overleaf-with-claude.git'

const SERVICES = [
  'chat', 'clsi', 'clsi-nginx', 'contacts', 'docstore',
  'document-updater', 'filestore', 'history-v1', 'mongo',
  'nginx', 'notifications', 'project-history', 'real-time',
  'redis', 'web',
]

function saveRc(root) {
  fs.writeFileSync(RC_FILE, JSON.stringify({ root }, null, 2))
}

function loadRc() {
  try {
    return JSON.parse(fs.readFileSync(RC_FILE, 'utf8'))
  } catch {
    return null
  }
}

function findRepoRoot(startDir = process.cwd()) {
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'develop', 'docker-compose.yml'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const rc = loadRc()
  if (rc?.root && fs.existsSync(path.join(rc.root, 'develop', 'docker-compose.yml'))) {
    return rc.root
  }
  return null
}

function developDir(root) {
  return path.join(root, 'develop')
}

function requireRoot() {
  const root = findRepoRoot()
  if (!root) {
    const chalk = require('chalk')
    console.error(chalk.red('Cannot find overleaf-with-claude repo. Run `olc install` first or cd into the repo.'))
    process.exit(1)
  }
  return root
}

function compose(root, args, opts = {}) {
  const devDir = developDir(root)
  const result = spawnSync('docker', ['compose', ...args], {
    cwd: devDir,
    stdio: opts.stdio || 'inherit',
    env: process.env,
  })
  if (opts.check && result.status !== 0) {
    throw new Error(`docker compose ${args[0]} failed (exit ${result.status})`)
  }
  return result
}

function composeStream(root, args, onData) {
  const devDir = developDir(root)
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['compose', ...args], {
      cwd: devDir,
      env: process.env,
    })
    proc.stdout.on('data', d => onData?.(d.toString()))
    proc.stderr.on('data', d => onData?.(d.toString()))
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)))
  })
}

function containerName(root, service) {
  const projectName = path.basename(root).replace(/[^a-z0-9]/gi, '').toLowerCase()
  return `${projectName}-${service}-1`
}

function getRunningContainers(root) {
  const res = compose(root, ['ps', '--format', 'json'], { stdio: 'pipe' })
  if (res.status !== 0 || !res.stdout) return []
  try {
    const raw = res.stdout.toString().trim()
    // docker compose ps --format json outputs one JSON object per line
    return raw.split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
  } catch {
    return []
  }
}

module.exports = {
  REPO_URL,
  SERVICES,
  RC_FILE,
  saveRc,
  loadRc,
  findRepoRoot,
  requireRoot,
  developDir,
  compose,
  composeStream,
  containerName,
  getRunningContainers,
}
