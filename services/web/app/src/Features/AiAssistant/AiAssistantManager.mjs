// Per-(user, project) Claude CLI conversation lifecycle.
//
// A `Session` is the long-lived object — it survives proc restarts and
// holds the things callers must not lose across a stop/start cycle:
//   * the temp working dir hydrated from the project's docs
//   * the fan-out set of SSE subscribers that receive events
//   * a bounded ring buffer of recent events for late subscribers
//
// The claude subprocess is a transient incarnation owned by the Session.
// `stop()` kills the proc and clears per-incarnation state (idle timer,
// fileSync); it leaves the Session in the registry so the next `send()`
// or `ensureStarted()` re-spawns against the same subscribers and the
// UI continues to receive events without reconnecting the SSE stream.
//
// Only `stopAllForUser` (OAuth disconnect) actually drops Sessions from
// the registry — that's the "forget everything" path.
//
// The model the CLI is spawned with is resolved from the user's stored
// preference at spawn time, so a preferences change picked up between
// restarts takes effect on the next proc without any plumbing through
// send/ensureStarted callers.
//
// File mirroring (chokidar + DocumentUpdater) lives in FileSync.mjs;
// this module just owns conversation/process lifecycle and event fan-out.

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import * as TokenStore from './TokenStore.mjs'
import * as ClaudeAuth from './ClaudeAuth.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import FileSync from './FileSync.mjs'
import { User } from '../../models/User.mjs'
import { createPatch } from 'diff'

const ROOT = join(tmpdir(), 'overleaf-ai-assistant')
const ALLOWED_MODES = new Set(['plan', 'bypassPermissions'])
const sessions = new Map() // key = `${userId}:${projectId}` -> Session

function newId() {
  return Math.random().toString(36).slice(2)
}

function key(userId, projectId) {
  return `${userId}:${projectId}`
}

const DEFAULT_MODEL = 'sonnet'

// Bound the per-message editor-activity prefix we send to Claude so a
// huge paste doesn't blow up the prompt. Anything over the per-file cap
// is replaced with a short "re-read with Read tool" note.
const MAX_DIFF_BYTES_PER_FILE = 8 * 1024
const MAX_DIFF_BYTES_TOTAL = 32 * 1024

// Persistent context injected at session start as a user-global
// CLAUDE.md. With HOME pointing at our temp cwd, the CLI picks this
// up automatically — no --system-prompt flag needed. The project's
// own CLAUDE.md (if the user has one in the LaTeX project) loads
// separately and stacks on top.
const SYSTEM_CONTEXT = `# Overleaf AI Assistant Environment

You are running inside an Overleaf LaTeX editor as the user's AI
pair-programmer. The user is editing this same project in a browser
side-by-side with this chat panel.

## Bidirectional file sync

- Files you write with Edit / Write are pushed into Overleaf's
  document store and appear in the user's CodeMirror editor in real
  time. No need to instruct the user to "save" anything.
- When the user edits in the editor, your **next user message** will
  be prefixed with a git-style unified diff block under
  \`[Overleaf editor activity ...]\`. The disk is already up to date
  at that point — the diff is just so you know what they changed
  without paying for a Read.
- If the diff for a file is omitted as too large, use the Read tool
  on that path to get the current content.

## What this working directory contains

- The current directory **is** the project root the user sees in
  Overleaf. Treat relative paths the same way they do.
- Only text source files are mirrored: \`.tex .bib .cls .sty .md
  .txt .json .yaml .yml\`. Binary assets (images, PDFs, fonts) are
  not synced and not present here — don't try to open or generate
  them.
- There is no build output: no \`.pdf\`, no \`.aux\`, no \`.log\`.
  The user compiles in Overleaf's UI; you have no access to
  \`latexmk\`, \`pdflatex\`, etc. Don't try to invoke them.
- This is not a git repository. Don't run \`git\` commands.

## House style

- The chat panel is narrow (right-rail). Keep responses concise;
  don't paste back content the editor already shows.
- When making structural edits, prefer Edit over Write so changes
  show as small diffs rather than full-file replacements.
- Match the project's existing LaTeX conventions (preamble layout,
  citation style, language) — inspect a few files before making
  cross-cutting changes.

## Plan mode (--permission-mode plan)

When the session starts in plan mode, your job is to **propose**
changes, not make them. The rules below are strict — follow them
exactly, even if the user asks otherwise.

- The current working directory **is** the user's Overleaf project.
  Modifying any file here is the same as modifying their live
  document — plan mode forbids it.
- Allowed: Read, Glob, Grep, and any other read-only inspection.
- **Blocked by the runtime**: Edit, Write, NotebookEdit, and any
  Bash command that mutates state. Don't call them. In particular:
  - Do **not** write the plan to a file (e.g. PLAN.md, plan.txt).
    The plan does not live on disk; it lives in the ExitPlanMode
    tool input.
  - Do **not** "draft" the plan by Writing it somewhere and then
    narrating "see above" — the user can't see file contents the
    way you can.
- The ExitPlanMode tool is **already loaded** in your default tool
  set. Call it directly. Do not call ToolSearch to look it up.
- When you have enough context, call ExitPlanMode exactly once with
  \`{ plan: "<full markdown plan>" }\`. The UI renders that markdown
  inside an interactive card with Approve / Request-changes buttons,
  so the plan is the tool input — not a separate text reply.
- After calling ExitPlanMode, stop. Don't add a closing text reply
  that restates the plan; it would be redundant and confusing.
- If the user approves, the runtime respawns you in bypass mode and
  includes the approved plan verbatim in the next user message —
  implement it then.
`

async function resolvePreferredModel(userId) {
  try {
    const user = await User.findById(userId, {
      'aiAssistant.preferredModel': 1,
    }).exec()
    return user?.aiAssistant?.preferredModel || DEFAULT_MODEL
  } catch (err) {
    logger.warn({ err, userId }, 'ai-assistant: model preference lookup failed')
    return DEFAULT_MODEL
  }
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
    // baseline[relPath] = "the content Claude last saw / wrote for this
    // file". Initialized in hydrateCwd, updated on forward-sync writes
    // and after a diff has been delivered to Claude via send().
    this.baseline = new Map()
    // Paths the editor (or another non-AI client) has rewritten since
    // Claude's last interaction. The next send() will diff baseline ->
    // disk for each and prepend a git-style patch to the user's
    // message, then move those paths into baseline.
    this.pendingExternalEdits = new Set()
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

    // Environment briefing for the CLI. Lives under .claude (i.e.
    // HOME/.claude/CLAUDE.md), so any CLAUDE.md the user keeps in the
    // project root stacks on top instead of being shadowed.
    await writeFile(join(credDir, 'CLAUDE.md'), SYSTEM_CONTEXT)

    // Copy project docs in. Binary file assets (filestore) are out of
    // scope for the first cut — Claude operates on .tex/.bib/etc only.
    // The hydrated content is also the diff baseline: the fresh proc
    // starts knowing exactly what's on disk, so subsequent reverse
    // syncs produce meaningful diffs against this snapshot.
    this.baseline.clear()
    this.pendingExternalEdits.clear()
    const docs = await ProjectEntityHandler.promises.getAllDocs(this.projectId)
    for (const [absPath, doc] of Object.entries(docs)) {
      const relPath = absPath.replace(/^\/+/, '')
      const content = (doc.lines || []).join('\n')
      const fullPath = join(this.cwd, relPath)
      await mkdir(join(fullPath, '..'), { recursive: true })
      await writeFile(fullPath, content)
      this.baseline.set(relPath, content)
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
    this.starting = (async () => {
      this.emit('status', { state: 'starting' })
      // Resolve model inside `starting` so the lookup happens lazily
      // and any later .start() awaiters block on the same promise.
      const model = await resolvePreferredModel(this.userId)
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

      // File sync: forward (claude -> editor) and reverse (editor ->
      // claude). Both directions emit `file-changed` so the UI can
      // show the path. Reverse also seeds pendingExternalEdits so the
      // next send() prepends a git-style diff for Claude to read.
      try {
        this.fileSync = await FileSync.start({
          userId: this.userId,
          projectId: this.projectId,
          cwd: this.cwd,
          onForwardChange: (path, content) => {
            this.emit('file-changed', { path })
            // Claude wrote this content; treat it as already known.
            this.baseline.set(path, content)
            this.pendingExternalEdits.delete(path)
          },
          onReverseChange: (path /* , content */) => {
            this.emit('file-changed', { path })
            // Defer diff computation until send() — there may be more
            // edits queued, and we want to diff against the disk
            // state at send time.
            this.pendingExternalEdits.add(path)
          },
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
    // Permission mode is baked into the CLI at spawn time, so switching
    // (plan <-> bypassPermissions) mid-conversation requires a fresh
    // proc. The Session is stable, so subscribers/history survive the
    // restart and the UI just sees a status:stopped → starting cycle.
    const requestedMode = ALLOWED_MODES.has(opts.permissionMode)
      ? opts.permissionMode
      : 'bypassPermissions'
    if (this.proc && this.permissionMode !== requestedMode) {
      logger.info(
        {
          userId: this.userId,
          projectId: this.projectId,
          from: this.permissionMode,
          to: requestedMode,
        },
        'ai-assistant: permission mode change, restarting proc'
      )
      await this.stop()
    }
    if (!this.proc) await this.start(opts)
    this.lastActivity = Date.now()
    this.resetIdleTimer()
    // Prepend a git-style summary of editor edits Claude hasn't seen
    // yet. This is what `pendingExternalEdits` is for: reverse-sync
    // queues paths, send() turns the queue into a single, bounded
    // notice and advances the baseline.
    const editorPrefix = await this.consumeExternalEditPrefix()
    const finalText = editorPrefix ? editorPrefix + '\n\n' + text : text
    const content = [{ type: 'text', text: finalText }]
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
    // The user sees only their own text in the transcript; the diff
    // prefix is an under-the-hood context injection.
    this.emit('user-message', { text })
  }

  // Drain pendingExternalEdits into a git-style unified-diff prefix
  // and advance baseline so the next call starts fresh. Returns null
  // if there's nothing to report.
  async consumeExternalEditPrefix() {
    if (this.pendingExternalEdits.size === 0) return null
    const paths = [...this.pendingExternalEdits].sort()
    this.pendingExternalEdits.clear()

    const blocks = []
    let totalBytes = 0
    let truncated = false
    for (const relPath of paths) {
      let after
      try {
        after = await readFile(join(this.cwd, relPath), 'utf8')
      } catch {
        continue // file vanished; skip
      }
      const before = this.baseline.get(relPath) ?? ''
      if (before === after) {
        // Reverse sync queued it, but a forward sync (or another
        // reverse pull) brought baseline back in line. Nothing to
        // tell Claude.
        this.baseline.set(relPath, after)
        continue
      }
      let body
      const patch = createPatch(relPath, before, after, '', '', { context: 3 })
      // Strip jsdiff's two-line file header ("Index:" + "===") — we
      // already label the block ourselves and the unified ---/+++
      // lines below it are what Claude actually wants.
      const trimmed = patch.replace(/^Index:.*\n=+\n/, '')
      if (trimmed.length > MAX_DIFF_BYTES_PER_FILE) {
        const beforeLines = before ? before.split('\n').length : 0
        const afterLines = after.split('\n').length
        body =
          `(diff omitted — patch is ${(trimmed.length / 1024).toFixed(1)} KB; ` +
          `file went from ${beforeLines} to ${afterLines} lines. ` +
          `Use the Read tool on ${relPath} to inspect the current content.)`
      } else if (totalBytes + trimmed.length > MAX_DIFF_BYTES_TOTAL) {
        body =
          `(diff omitted — total prefix would exceed budget. ` +
          `Use the Read tool on ${relPath} to inspect.)`
        truncated = true
      } else {
        body = '```diff\n' + trimmed.trimEnd() + '\n```'
        totalBytes += trimmed.length
      }
      blocks.push(`### ${relPath}\n${body}`)
      // Whether or not we sent the patch, Claude is now considered to
      // have a fresh view of this file (it has the path and can read
      // it on demand).
      this.baseline.set(relPath, after)
    }

    if (blocks.length === 0) return null
    const header =
      '[Overleaf editor activity since your last message — files have ' +
      'already been updated on disk:]'
    const footer = truncated
      ? '\n\n(Some diffs were dropped to keep this prefix small; ' +
        'use Read on those paths if you need details.)'
      : ''
    return header + '\n\n' + blocks.join('\n\n') + footer
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
    // Capture the proc handle *before* cleanup() nulls it; otherwise
    // the deferred SIGKILL fires against null and a proc that didn't
    // honour SIGTERM is leaked forever.
    const proc = this.proc
    if (proc) {
      try {
        proc.kill('SIGTERM')
      } catch {}
      setTimeout(() => {
        try {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGKILL')
          }
        } catch {}
      }, 2000).unref()
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
  async ensureStarted(userId, projectId, sendInitial) {
    const s = get(userId, projectId)
    if (!s.proc && !s.starting) {
      await s.start()
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
  // Kill the current claude proc but keep the Session registered so
  // subscribers and history survive. The next send() / ensureStarted()
  // will spawn a fresh proc against the same subscriber set; events
  // continue to reach any open SSE without a client reconnect.
  async stop(userId, projectId) {
    const s = sessions.get(key(userId, projectId))
    if (!s) return
    await s.stop()
  },
  // Hard purge for OAuth disconnect: stop every Session for the user
  // and drop them from the registry entirely.
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
