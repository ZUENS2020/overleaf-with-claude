// Login flow that delegates to the bundled `claude auth login --claudeai`
// CLI. We spawn it with a per-user temp HOME, capture the OAuth URL it
// prints, return that URL to the web client, and when the user pastes the
// code back we feed it to the CLI's stdin. The CLI itself handles the
// token exchange and writes `.claude/.credentials.json`, which we then
// read, encrypt, and store in Mongo.
//
// This sidesteps having to track the OAuth parameters (client_id, scopes,
// authorize/token URLs, redirect URI) ourselves — whatever Claude Code
// uses at runtime is what we use.

import { spawn } from 'node:child_process'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'

// Pending login sessions keyed by userId. Each holds the spawned CLI
// process and its temp HOME so we can feed it a code later.
const pending = new Map()

const PROMPT_TIMEOUT_MS = 30_000
const SUBMIT_TIMEOUT_MS = 60_000

function urlFromOutput(text) {
  // Accept any host that ends in /oauth/authorize so we don't break
  // when Anthropic moves the endpoint (already happened once:
  // claude.ai/oauth/authorize → claude.com/cai/oauth/authorize), and
  // so staging hosts (claude-ai.staging.ant.dev, etc) work too.
  const m = text.match(/(https:\/\/[^\s)>'"]+\/oauth\/authorize\?[^\s)>'"]+)/)
  return m ? m[1] : null
}

export async function startLogin(userId) {
  // Abort any previous attempt for this user.
  await abort(userId)

  const home = await mkdtemp(join(tmpdir(), 'overleaf-claude-login-'))
  const bin = Settings.aiAssistant?.claudeBin || 'claude'
  const proc = spawn(bin, ['auth', 'login', '--claudeai'], {
    cwd: home,
    env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', d => (stdout += d.toString('utf8')))
  proc.stderr.on('data', d => (stderr += d.toString('utf8')))

  // Wait until we see the authorize URL in CLI output.
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for authorize URL'))
    }, PROMPT_TIMEOUT_MS)
    const check = () => {
      const u = urlFromOutput(stdout + stderr)
      if (u) {
        clearTimeout(timer)
        resolve(u)
      }
    }
    proc.stdout.on('data', check)
    proc.stderr.on('data', check)
    proc.on('exit', () => {
      clearTimeout(timer)
      reject(new Error(`claude auth login exited early: ${stderr || stdout}`))
    })
    proc.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })

  pending.set(userId, { proc, home, stdoutRef: () => stdout + stderr })
  return url
}

export async function submitCode(userId, code) {
  const slot = pending.get(userId)
  if (!slot) throw new Error('no_pending_login')
  const { proc, home } = slot
  // The CLI accepts the code on stdin followed by newline.
  proc.stdin.write(code.trim() + '\n')

  // Wait for the CLI to exit (success or failure).
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for claude auth login to exit')),
      SUBMIT_TIMEOUT_MS
    )
    proc.on('exit', code => {
      clearTimeout(timer)
      resolve(code)
    })
    proc.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })

  if (exitCode !== 0) {
    const tail = slot.stdoutRef().slice(-400)
    pending.delete(userId)
    await rm(home, { recursive: true, force: true }).catch(() => {})
    throw new Error(`claude auth login failed (exit ${exitCode}): ${tail}`)
  }

  // Read the credentials the CLI just wrote.
  const credPath = join(home, '.claude', '.credentials.json')
  let creds
  try {
    creds = JSON.parse(await readFile(credPath, 'utf8'))
  } catch (err) {
    pending.delete(userId)
    await rm(home, { recursive: true, force: true }).catch(() => {})
    throw new Error(`credentials file missing after login: ${err.message}`)
  }

  pending.delete(userId)
  await rm(home, { recursive: true, force: true }).catch(() => {})

  // Normalize for storage. The CLI writes:
  //   { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, subscriptionType } }
  const o = creds.claudeAiOauth || {}
  return {
    raw: creds,
    accessToken: o.accessToken,
    refreshToken: o.refreshToken,
    expiresAt: o.expiresAt,
    scopes: o.scopes || [],
    subscriptionType: o.subscriptionType || null,
    account: null,
  }
}

export async function abort(userId) {
  const slot = pending.get(userId)
  if (!slot) return
  pending.delete(userId)
  try {
    slot.proc.kill('SIGTERM')
  } catch {}
  await rm(slot.home, { recursive: true, force: true }).catch(() => {})
}

// Render the stored credentials back into the file format the spawned
// chat-session CLI expects (mirrors what claude itself writes).
export function toCredentialsFile(tokens) {
  if (tokens.raw) return tokens.raw
  return {
    claudeAiOauth: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes || [],
      subscriptionType: tokens.subscriptionType || 'unknown',
    },
  }
}
