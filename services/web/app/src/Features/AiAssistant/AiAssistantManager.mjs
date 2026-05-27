// Per-(user, project) Claude CLI subprocess lifecycle. The CLI is spawned
// with `--output-format stream-json --input-format stream-json` so we can
// drive both directions over its stdio. Each session keeps:
//   * a temp working dir hydrated from the project's docs
//   * a fan-out set of SSE subscribers that receive events emitted by the
//     subprocess
//   * an idle timer that kills the process after AI_ASSISTANT_IDLE_MS of
//     no user input
//
// File mirroring (chokidar + DocumentUpdater) lives in FileSync.mjs; this
// module just owns process lifecycle and event fan-out.

import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import * as TokenStore from './TokenStore.mjs'
import * as ClaudeAuth from './ClaudeAuth.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import FileSync from './FileSync.mjs'

const ROOT = join(tmpdir(), 'overleaf-ai-assistant')
const ALLOWED_MODES = new Set(['plan', 'bypassPermissions'])
const sessions = new Map() // key = `${userId}:${projectId}` -> Session

function newId() {
  return Math.random().toString(36).slice(2)
}

function key(userId, projectId) {
  return `${userId}:${projectId}`
}

class Session {
  constructor(userId, projectId) {
    this.userId = String(userId)
    this.projectId = String(projectId)
    this.subscribers = new Set()
    this.proc = null
    this.cwd = join(ROOT, `${this.userId}-${this.projectId}`)
    this.lastActivity = Date.now()
    this.starting = null // Promise during boot
    this.idleTimer = null
    this.fileSync = null
    this.history = [] // recent events for late subscribers
  }

  emit(event, data) {
    const msg = { event, data, t: Date.now() }
    this.history.push(msg)
    if (this.history.length > 200) this.history.shift()
    for (const fn of this.subscribers) {
      try {
        fn(event, data)
      } catch (err) {
        logger.warn({ err }, 'ai-assistant subscriber threw')
      }
    }
  }

  resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const ms = Settings.aiAssistant?.idleMs || 600_000
    this.idleTimer = setTimeout(() => {
      logger.info(
        { userId: this.userId, projectId: this.projectId },
        'ai-assistant idle, stopping'
      )
      this.stop().catch(() => {})
    }, ms)
  }

  async hydrateCwd() {
    await rm(this.cwd, { recursive: true, force: true })
    await mkdir(this.cwd, { recursive: true })
    const credDir = join(this.cwd, '.claude')
    await mkdir(credDir, { recursive: true })

    // Write OAuth credentials so the CLI picks them up via HOME=cwd.
    const tok = await TokenStore.ensureFresh(this.userId)
    if (!tok) throw new Error('not_connected')
    await writeFile(
      join(credDir, '.credentials.json'),
      JSON.stringify(ClaudeAuth.toCredentialsFile(tok))
    )

    // Copy project docs in. Binary file assets (filestore) are out of
    // scope for the first cut — Claude operates on .tex/.bib/etc only.
    const docs = await ProjectEntityHandler.promises.getAllDocs(this.projectId)
    for (const [relPath, doc] of Object.entries(docs)) {
      const fullPath = join(this.cwd, relPath.replace(/^\//, ''))
      await mkdir(join(fullPath, '..'), { recursive: true })
      await writeFile(fullPath, (doc.lines || []).join('\n'))
    }
  }

  async start(opts = {}) {
    if (this.proc) return
    if (this.starting) return this.starting
    // Only two modes are exposed in the UI now: plan (read-only) and
    // bypassPermissions (the default — full auto). Any other value
    // (incl. older clients sending 'default' or 'acceptEdits') is
    // coerced so the spawned CLI never sees an unsupported flag value.
    this.permissionMode = ALLOWED_MODES.has(opts.permissionMode)
      ? opts.permissionMode
      : 'bypassPermissions'
    const model = opts.model || 'sonnet'
    this.starting = (async () => {
      this.emit('status', { state: 'starting' })
      await this.hydrateCwd()

      const bin = Settings.aiAssistant?.claudeBin || 'claude'
      const args = [
        '--print',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', this.permissionMode,
        '--model', model,
      ]
      const env = {
        ...process.env,
        HOME: this.cwd,
        // Drop API key so the CLI uses OAuth credentials.
        ANTHROPIC_API_KEY: '',
      }
      logger.info(
        { userId: this.userId, projectId: this.projectId, bin },
        'spawning claude'
      )
      this.proc = spawn(bin, args, {
        cwd: this.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.proc.on('error', err => {
        logger.error({ err }, 'claude spawn error')
        this.emit('error', { message: err.message })
      })
      this.proc.on('exit', (code, signal) => {
        logger.info({ code, signal }, 'claude exited')
        this.emit('status', { state: 'stopped', code, signal })
        this.cleanup()
      })

      // Parse stream-json line by line.
      let buf = ''
      this.proc.stdout.on('data', chunk => {
        buf += chunk.toString('utf8')
        let idx
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line)
            this.handleClaudeMessage(obj)
          } catch (err) {
            logger.warn({ err, line: line.slice(0, 200) }, 'bad json from claude')
          }
        }
      })
      this.proc.stderr.on('data', chunk => {
        const s = chunk.toString('utf8')
        logger.debug({ stderr: s.slice(0, 500) }, 'claude stderr')
      })

      // File watcher → DocumentUpdater. Emits a small file-changed
      // notice to the chat so the user sees which files Claude
      // touched in this turn.
      try {
        this.fileSync = await FileSync.start({
          userId: this.userId,
          projectId: this.projectId,
          cwd: this.cwd,
          onFileChanged: path => this.emit('file-changed', { path }),
        })
      } catch (err) {
        logger.warn({ err }, 'file sync start failed; continuing without it')
      }

      this.emit('status', { state: 'running' })
      this.resetIdleTimer()
    })()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  // Translate Claude CLI stream-json events to the UI event shape.
  handleClaudeMessage(obj) {
    if (obj.type === 'assistant' && obj.message?.content) {
      // Surface auth / rate-limit errors attached directly to the message.
      if (obj.error) {
        this.emit('error', { message: obj.error, type: 'api_error' })
      }
      for (const block of obj.message.content) {
        if (block.type === 'text') {
          this.emit('assistant-message', { text: block.text })
        } else if (block.type === 'thinking') {
          this.emit('thinking', { text: block.thinking || block.text || '' })
        } else if (block.type === 'tool_use') {
          this.emit('tool-use', {
            id: block.id,
            name: block.name,
            input: block.input,
          })
          if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
            this.emit('todos', { todos: block.input.todos })
          }
        }
      }
    } else if (obj.type === 'user' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'tool_result') {
          this.emit('tool-result', {
            id: block.tool_use_id,
            output: block.content,
            isError: block.is_error || false,
          })
        }
      }
    } else if (obj.type === 'result') {
      this.emit('turn-end', {
        usage: obj.usage || null,
        cost: obj.total_cost_usd || null,
      })
      if (obj.is_error && obj.result) {
        this.emit('error', { message: String(obj.result), type: 'result_error' })
      }
    }
    if (obj.type === 'permission_request') {
      this.emit('permission-request', {
        id: obj.id || obj.request_id || newId(),
        tool: obj.tool_name || obj.tool || 'unknown',
        input: obj.input || {},
        description: obj.description || obj.message || '',
      })
    }
  }

  async send(text, opts = {}) {
    if (!this.proc) await this.start(opts)
    this.lastActivity = Date.now()
    this.resetIdleTimer()
    const content = [{ type: 'text', text }]
    // Attach images if provided (base64-encoded)
    if (Array.isArray(opts.images) && opts.images.length > 0) {
      for (const img of opts.images) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType || 'image/png',
            data: img.data,
          },
        })
      }
    }
    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    }
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
    this.emit('user-message', { text })
  }

  // Provisional / untested. The claude CLI in `--print` non-interactive
  // stream-json mode applies whatever --permission-mode was passed at
  // spawn and does NOT prompt the caller for tool-by-tool approval, so
  // in practice `permission_request` events do not appear in the
  // output stream and this method is never reached. The wiring stays
  // in place so that if/when the CLI adds an out-of-band permission
  // protocol over stdin we can adopt it without rewriting the UI; the
  // envelope shape below is a guess that will need to match whatever
  // the CLI actually accepts.
  respondPermission(permissionId, allow) {
    if (!this.proc?.stdin) return
    const msg = {
      type: 'permission_response',
      id: permissionId,
      allow,
    }
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  async stop() {
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM')
      } catch {}
      // Give it 2s, then SIGKILL.
      setTimeout(() => {
        try {
          this.proc?.kill('SIGKILL')
        } catch {}
      }, 2000)
    }
    this.cleanup()
  }

  cleanup() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.fileSync) {
      this.fileSync.stop().catch(() => {})
      this.fileSync = null
    }
    this.proc = null
  }
}

function get(userId, projectId) {
  const k = key(userId, projectId)
  let s = sessions.get(k)
  if (!s) {
    s = new Session(userId, projectId)
    sessions.set(k, s)
  }
  return s
}

export default {
  async ensureStarted(userId, projectId, sendInitial, opts = {}) {
    const s = get(userId, projectId)
    if (!s.proc && !s.starting) {
      await s.start(opts)
    } else if (s.starting) {
      await s.starting
    }
    // Replay recent history so a fresh subscriber sees context.
    if (sendInitial) {
      for (const m of s.history.slice(-50)) sendInitial(m.event, m.data)
    }
  },
  subscribe(userId, projectId, fn) {
    const s = get(userId, projectId)
    s.subscribers.add(fn)
    return () => s.subscribers.delete(fn)
  },
  async send(userId, projectId, text, opts) {
    const s = get(userId, projectId)
    await s.send(text, opts)
  },
  respondPermission(userId, projectId, permissionId, allow) {
    const s = get(userId, projectId)
    s.respondPermission(permissionId, allow)
  },
  async stop(userId, projectId) {
    const k = key(userId, projectId)
    const s = sessions.get(k)
    if (!s) return
    await s.stop()
    sessions.delete(k)
  },
  async stopAllForUser(userId) {
    const prefix = `${userId}:`
    const stops = []
    for (const [k, s] of sessions) {
      if (k.startsWith(prefix)) {
        stops.push(s.stop().catch(() => {}))
        sessions.delete(k)
      }
    }
    await Promise.all(stops)
  },
}
