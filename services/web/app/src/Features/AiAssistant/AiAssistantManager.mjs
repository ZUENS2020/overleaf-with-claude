// Per-(user, project) Claude conversation lifecycle, built on the
// Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
//
// A `Session` is the long-lived object. It survives query restarts and
// owns the things callers must not lose across a stop/start cycle:
//   * the temp working dir hydrated from the project's docs
//   * the fan-out set of SSE subscribers that receive events
//   * a bounded ring buffer of recent events for late subscribers
//   * the docId baseline / pending editor edits used to render git-style
//     diffs to Claude on the next user turn
//
// The SDK `query` is a transient incarnation owned by the Session.
// `stop()` closes the query and clears per-incarnation state (idle
// timer, fileSync, pending permission requests); the Session stays in
// the registry so the next `send()` re-opens a query against the same
// subscriber set and the UI continues without an SSE reconnect.
//
// Only `stopAllForUser` (OAuth disconnect) actually drops Sessions
// from the registry — that's the "forget everything" path.
//
// Permission decisions for tools that require user approval flow
// through `canUseTool`. ExitPlanMode in particular is routed to the
// UI as a permission-request event with tool === 'ExitPlanMode'; the
// frontend renders an interactive PlanCard whose Approve / Request-
// changes buttons POST /permission-response, which resolves the
// awaiting promise here. Approval also flips permissionMode to
// `bypassPermissions` so the same query can immediately start writing.
//
// File mirroring (chokidar + DocumentUpdater) lives in FileSync.mjs;
// this module just owns conversation/process lifecycle and event
// fan-out.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import { query } from '@anthropic-ai/claude-agent-sdk'
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

## Plan mode (permissionMode = "plan")

When the session is in plan mode, your job is to **propose** changes,
not make them. Follow these rules exactly:

- The cwd **is** the user's live Overleaf project. Modifying any
  file here is the same as modifying their document — plan mode
  forbids it.
- Allowed: Read, Glob, Grep, and any other read-only inspection.
- Blocked: Edit, Write, NotebookEdit, and mutating Bash commands.
- Do **not** write the plan to a file (e.g. PLAN.md). The plan does
  not live on disk; it lives in the ExitPlanMode tool input.
- Do **not** call ToolSearch to look up ExitPlanMode — it is already
  in your default tool set.
- When you have enough context, call ExitPlanMode exactly once with
  \`{ plan: "<full markdown plan>" }\`. The UI pauses on that tool
  call and renders the plan as an interactive card with Approve /
  Request-changes buttons. Do not narrate the plan again afterwards.
- If approved, the SDK switches you to bypass mode and resumes the
  same turn — implement the plan then and there. If the user
  requests changes, ExitPlanMode is denied with their feedback;
  revise and call ExitPlanMode again.
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
    // SDK-side state.
    this.query = null
    this.permissionMode = 'bypassPermissions'
    this.promptQueue = []
    this.promptResolver = null
    this.queryClosed = false
    // canUseTool waiters, keyed by request id we send to the UI.
    this.pendingPermissionRequests = new Map()
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
    // The hydrated content is also the diff baseline: the fresh query
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
    if (this.query) return
    if (this.starting) return this.starting
    this.permissionMode = ALLOWED_MODES.has(opts.permissionMode)
      ? opts.permissionMode
      : 'bypassPermissions'
    this.starting = (async () => {
      this.emit('status', { state: 'starting' })
      const model = await resolvePreferredModel(this.userId)
      await this.hydrateCwd()

      this.queryClosed = false
      this.promptQueue = []
      this.promptResolver = null

      const promptIterable = this._buildPromptIterable()

      logger.info(
        {
          userId: this.userId,
          projectId: this.projectId,
          model,
          mode: this.permissionMode,
        },
        'ai-assistant: opening SDK query'
      )

      this.query = query({
        prompt: promptIterable,
        options: {
          cwd: this.cwd,
          model,
          permissionMode: this.permissionMode,
          env: {
            ...process.env,
            HOME: this.cwd,
            // OAuth credentials come from HOME/.claude/.credentials.json;
            // make sure no stale API key wins precedence.
            ANTHROPIC_API_KEY: '',
          },
          canUseTool: (toolName, input, ctx) =>
            this._handleCanUseTool(toolName, input, ctx),
        },
      })

      // Drain the SDK's message iterator in the background. Errors
      // here end the query; subscribers learn via status:stopped.
      this._consumeQuery().catch(err => {
        logger.error(
          { err, userId: this.userId, projectId: this.projectId },
          'ai-assistant: query consumer crashed'
        )
        this.emit('error', { message: err?.message || String(err) })
      })

      // File sync. Forward (claude -> editor) keeps baseline in lock-
      // step with what Claude itself wrote; reverse (editor -> claude)
      // queues paths so consumeExternalEditPrefix() can build a diff
      // prefix on the next send().
      try {
        this.fileSync = await FileSync.start({
          userId: this.userId,
          projectId: this.projectId,
          cwd: this.cwd,
          onForwardChange: (path, content) => {
            this.emit('file-changed', { path })
            this.baseline.set(path, content)
            this.pendingExternalEdits.delete(path)
          },
          onReverseChange: path => {
            this.emit('file-changed', { path })
            this.pendingExternalEdits.add(path)
          },
        })
      } catch (err) {
        logger.warn({ err }, 'ai-assistant: file sync start failed')
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

  // Async iterable the SDK pulls user messages from. Yields whatever
  // send() pushes into promptQueue, or blocks on promptResolver. Ends
  // when stop() flips queryClosed.
  _buildPromptIterable() {
    const self = this
    return (async function* () {
      while (!self.queryClosed) {
        if (self.promptQueue.length > 0) {
          yield self.promptQueue.shift()
          continue
        }
        await new Promise(resolve => {
          self.promptResolver = resolve
        })
      }
    })()
  }

  _wakePromptIterable() {
    if (this.promptResolver) {
      const r = this.promptResolver
      this.promptResolver = null
      r()
    }
  }

  async _consumeQuery() {
    try {
      for await (const msg of this.query) {
        this._handleSDKMessage(msg)
      }
    } finally {
      this.emit('status', { state: 'stopped' })
      this.cleanup()
    }
  }

  // Translate SDK messages into the UI event shape. ExitPlanMode is
  // intentionally absent from this path: it's surfaced via canUseTool
  // as a permission-request, so the model's tool_use/tool_result for
  // it would otherwise be a duplicate render.
  _handleSDKMessage(obj) {
    if (obj.type === 'assistant' && obj.message?.content) {
      if (obj.error) {
        this.emit('error', { message: obj.error, type: 'api_error' })
      }
      for (const block of obj.message.content) {
        if (block.type === 'text') {
          this.emit('assistant-message', { text: block.text })
        } else if (block.type === 'thinking') {
          this.emit('thinking', { text: block.thinking || block.text || '' })
        } else if (block.type === 'tool_use') {
          if (block.name === 'ExitPlanMode') continue
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
          // Tool result for ExitPlanMode is the Approve/Deny outcome
          // we already showed via the permission-request flow.
          if (this._isExitPlanResult(block)) continue
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
  }

  // Best-effort check: did this tool_result belong to an ExitPlanMode
  // tool_use? The SDK gives us the tool_use_id we routed through
  // canUseTool, so we keep a small Set of those for lookup.
  _isExitPlanResult(block) {
    return (
      this._exitPlanToolUseIds && this._exitPlanToolUseIds.has(block.tool_use_id)
    )
  }

  // canUseTool fires for every tool call the SDK is about to execute
  // (and that isn't covered by allowedTools / permission mode auto-
  // decisions). We only need to gate ExitPlanMode interactively; in
  // plan mode the SDK auto-denies Write/Edit etc., and in bypass mode
  // it auto-allows everything else.
  async _handleCanUseTool(toolName, input /* , ctx */) {
    if (toolName !== 'ExitPlanMode') {
      return { behavior: 'allow', updatedInput: input }
    }
    const id = newId()
    if (!this._exitPlanToolUseIds) this._exitPlanToolUseIds = new Set()
    // The SDK exposes the tool_use_id via the ctx in newer versions;
    // for compatibility we just remember our request id and recognise
    // the result by either signal. The UI's permission-request id is
    // what we round-trip with the frontend.
    return new Promise(resolve => {
      this.pendingPermissionRequests.set(id, resolve)
      this.emit('permission-request', {
        id,
        tool: 'ExitPlanMode',
        input,
        description:
          'Claude proposes a plan. Approve to let it implement, or ' +
          'request changes to refine.',
      })
    })
  }

  // Called by AiAssistantController in response to a frontend POST to
  // /ai-assistant/permission-response. Resolves the awaiting canUseTool
  // promise. Approving ExitPlanMode also flips permissionMode to
  // bypass on the live query so the model can continue writing.
  async respondPermission(requestId, allow, message) {
    const resolve = this.pendingPermissionRequests.get(requestId)
    if (!resolve) return
    this.pendingPermissionRequests.delete(requestId)
    if (allow) {
      try {
        await this.query?.setPermissionMode('bypassPermissions')
        this.permissionMode = 'bypassPermissions'
        this.emit('permission-mode', { mode: 'bypassPermissions' })
      } catch (err) {
        logger.warn({ err }, 'ai-assistant: setPermissionMode failed')
      }
      resolve({ behavior: 'allow' })
    } else {
      resolve({
        behavior: 'deny',
        message:
          message ||
          'User requested changes to the plan. Wait for their next ' +
            'message before revising.',
      })
    }
  }

  async send(text, opts = {}) {
    const requestedMode = ALLOWED_MODES.has(opts.permissionMode)
      ? opts.permissionMode
      : this.permissionMode
    if (!this.query) {
      await this.start({ permissionMode: requestedMode })
    } else if (requestedMode !== this.permissionMode) {
      // Mode switch in-flight: ask the SDK to flip without restarting
      // the query — context, subscribers, and history all survive.
      try {
        await this.query.setPermissionMode(requestedMode)
        this.permissionMode = requestedMode
        this.emit('permission-mode', { mode: requestedMode })
      } catch (err) {
        logger.warn({ err, requestedMode }, 'ai-assistant: mode switch failed')
      }
    }

    this.lastActivity = Date.now()
    this.resetIdleTimer()

    const editorPrefix = await this.consumeExternalEditPrefix()
    const finalText = editorPrefix ? editorPrefix + '\n\n' + text : text
    const content = [{ type: 'text', text: finalText }]
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

    this.promptQueue.push({
      type: 'user',
      message: { role: 'user', content },
    })
    this._wakePromptIterable()
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
        continue
      }
      const before = this.baseline.get(relPath) ?? ''
      if (before === after) {
        this.baseline.set(relPath, after)
        continue
      }
      let body
      const patch = createPatch(relPath, before, after, '', '', { context: 3 })
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

  async stop() {
    this.queryClosed = true
    this._wakePromptIterable()
    // Reject pending permission requests so canUseTool callers don't
    // hang the SDK's shutdown.
    for (const resolve of this.pendingPermissionRequests.values()) {
      resolve({ behavior: 'deny', message: 'Session ended.' })
    }
    this.pendingPermissionRequests.clear()
    const q = this.query
    if (q) {
      try {
        await q.close()
      } catch (err) {
        logger.debug({ err }, 'ai-assistant: query close threw')
      }
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
    this.query = null
    this.promptQueue = []
    this.promptResolver = null
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
    if (!s.query && !s.starting) {
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
  async respondPermission(userId, projectId, permissionId, allow, message) {
    const s = get(userId, projectId)
    await s.respondPermission(permissionId, allow, message)
  },
  // Close the live query but keep the Session registered so subscribers
  // and history survive. The next send() / ensureStarted() re-opens
  // a query against the same subscriber set.
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
