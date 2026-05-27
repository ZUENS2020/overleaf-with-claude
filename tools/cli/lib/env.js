'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ENV_KEYS = [
  { key: 'SESSION_SECRET',           desc: 'HTTP session secret',                  secret: true,  default: () => crypto.randomBytes(32).toString('hex') },
  { key: 'PUBLIC_URL',               desc: 'Public URL (e.g. http://192.168.0.6:8082)', required: true, default: 'http://localhost:8082' },
  { key: 'AI_ASSISTANT_TOKEN_KEY',   desc: 'AES key for Claude OAuth tokens (hex)', secret: true,  default: () => crypto.randomBytes(32).toString('hex') },
  { key: 'AI_ASSISTANT_CLAUDE_BIN',  desc: 'Path to claude CLI inside web container', default: 'claude' },
  { key: 'AI_ASSISTANT_IDLE_MS',     desc: 'Idle timeout before killing subprocess (ms)', default: '600000' },
  { key: 'WEB_API_USER',             desc: 'Internal API user',                     default: 'overleaf' },
  { key: 'WEB_API_PASSWORD',         desc: 'Internal API password',                 secret: true,  default: () => crypto.randomBytes(16).toString('hex') },
]

const STATIC_VARS = `CHAT_HOST=chat
CLSI_HOST=clsi
DOWNLOAD_HOST=http://clsi-nginx:8080
CONTACTS_HOST=contacts
DOCSTORE_HOST=docstore
DOCUMENT_UPDATER_HOST=document-updater
FILESTORE_HOST=filestore
GRACEFUL_SHUTDOWN_DELAY_SECONDS=0
HISTORY_V1_HOST=history-v1
HISTORY_REDIS_HOST=redis
LISTEN_ADDRESS=0.0.0.0
MONGO_HOST=mongo
MONGO_URL=mongodb://mongo/sharelatex?directConnection=true
NOTIFICATIONS_HOST=notifications
PROJECT_HISTORY_HOST=project-history
QUEUES_REDIS_HOST=redis
DSMP_REDIS_HOST=redis
REALTIME_HOST=real-time
REDIS_HOST=redis
V1_HISTORY_HOST=history-v1
WEBPACK_HOST=webpack
WEB_HOST=web`

function envPath(root) {
  return path.join(root, 'develop', 'dev.env')
}

function readEnv(root) {
  const file = envPath(root)
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return out
}

function writeEnv(root, values) {
  const file = envPath(root)
  const lines = [STATIC_VARS, '']
  for (const { key, desc, secret } of ENV_KEYS) {
    if (desc) lines.push(`# ${desc}`)
    const val = values[key] ?? ''
    lines.push(`${key}=${val}`)
  }
  fs.writeFileSync(file, lines.join('\n') + '\n')
}

async function configWizard(root, forceAll = false) {
  const inquirer = require('inquirer')
  const chalk = require('chalk')
  const current = readEnv(root)
  const answers = {}

  console.log(chalk.cyan('\nConfiguring dev.env\n'))

  for (const { key, desc, required, default: def, secret } of ENV_KEYS) {
    const currentVal = current[key]
    const defaultVal = typeof def === 'function' ? def() : def

    if (currentVal && !forceAll) {
      answers[key] = currentVal
      if (!secret) console.log(chalk.gray(`  ${key} = ${currentVal} (kept)`))
      else console.log(chalk.gray(`  ${key} = ******* (kept)`))
      continue
    }

    const { value } = await inquirer.prompt([{
      type: secret ? 'password' : 'input',
      name: 'value',
      message: `${key} (${desc}):`,
      default: defaultVal,
      validate: v => (required && !v) ? `${key} is required` : true,
    }])
    answers[key] = value || defaultVal
  }

  writeEnv(root, answers)
  console.log(chalk.green('\n✓ dev.env written\n'))
  return answers
}

module.exports = { ENV_KEYS, envPath, readEnv, writeEnv, configWizard }
