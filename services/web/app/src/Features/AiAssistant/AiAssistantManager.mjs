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

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
// CLAUDE.md. With HOME pointing at our temp cwd the CLI picks this
// up automatically. Deliberately minimal: the SDK's own permission-
// mode system reminders handle plan-mode rules, tool conventions,
// etc.; over-instructing here only confuses the model when its
// built-in protocol changes between releases.
const SYSTEM_CONTEXT = `This working directory is the user's Overleaf LaTeX project. Files you read and write here are the same files they see in the Overleaf editor.
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
    // Active ExitPlanMode flow. Two slots so the UI and the SDK can
    // arrive in either order:
    //   activePlanRequestId  — id of the permission-request event we
    //     already sent to the frontend (so the user can act). Set
    //     either when FileSync sees the plan file written, or when
    //     canUseTool fires for ExitPlanMode, whichever happens first.
    //   pendingPlanSdkResolver — the canUseTool resolver waiting for
    //     our return. Null until the SDK actually invokes
    //     canUseTool. respondPermission() resolves it once we know
    //     the user's decision.
    // Tool-use id tracking for ExitPlanMode so that its tool_result
    // can be filtered out of the UI message stream (the PlanCard
    // already represents the outcome).
    this.activePlanRequestId = null
    this.pendingPlanSdkResolver = null
    this._exitPlanToolUseIds = new Set()
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
          // The SDK ships per-platform CLI binaries as optional npm
          // peers (e.g. @anthropic-ai/claude-agent-sdk-linux-x64).
          // Our container installs the SDK from a vendored tarball
          // without those peers, so point the SDK at the standalone
          // `claude` CLI that's already on PATH from the
          // @anthropic-ai/claude-code global install.
          pathToClaudeCodeExecutable:
            Settings.aiAssistant?.claudeBin || 'claude',
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
          onPlanWritten: content => this._surfacePlanCard(content),
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
  // intentionally absent from this path: it's surfaced via the
  // PlanCard (either from canUseTool or from the file-write hook),
  // so the model's tool_use/tool_result for it would otherwise be a
  // duplicate render.
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
          if (block.name === 'ExitPlanMode') {
            this._exitPlanToolUseIds.add(block.id)
            continue
          }
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
          if (this._exitPlanToolUseIds.has(block.tool_use_id)) continue
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

  // canUseTool fires for every tool call the SDK is about to execute
  // and isn't covered by allowedTools / permission-mode auto-decisions.
  // In bypass mode the SDK auto-allows everything; in plan mode it
  // auto-denies mutating tools. The one interactive case is
  // ExitPlanMode: the user needs to approve before the model leaves
  // plan mode and starts writing.
  //
  // Plan-content surfacing happens via two paths, whichever fires
  // first:
  //   1. FileSync's onPlanWritten hook (this is what the VS Code
  //      extension uses). claude-code 2.1.x writes the plan to
  //      <cwd>/.claude/plans/<slug>.md; the moment the file lands,
  //      _surfacePlanCard surfaces it to the UI.
  //   2. canUseTool fires for ExitPlanMode. If the PlanCard isn't
  //      already shown (rare race — Haiku occasionally calls
  //      ExitPlanMode without writing a plan first), we read the
  //      plans dir on demand.
  // Either way, respondPermission() reconciles the user's click
  // with whichever resolver is waiting.
  async _handleCanUseTool(toolName, input /* , ctx */) {
    if (toolName !== 'ExitPlanMode') {
      return { behavior: 'allow', updatedInput: input }
    }
    return new Promise(resolve => {
      this.pendingPlanSdkResolver = resolve
      if (this.activePlanRequestId) return // PlanCard already shown
      this._readMostRecentPlanArtifact().then(plan => {
        this._surfacePlanCard(plan)
      })
    })
  }

  // Emit the PlanCard, idempotently. Called both from the FileSync
  // plan-write hook (the common case) and from canUseTool when the
  // model reached ExitPlanMode without ever writing a plan file.
  _surfacePlanCard(planText) {
    if (this.activePlanRequestId) return
    const id = newId()
    this.activePlanRequestId = id
    this.emit('permission-request', {
      id,
      tool: 'ExitPlanMode',
      input: planText ? { plan: planText } : {},
      description: planText
        ? 'Claude has prepared a plan. Approve to let it implement, or ' +
          'request changes to refine.'
        : 'Claude is ready to exit plan mode and start making changes. ' +
          'Approve to continue, or deny to keep planning.',
    })
  }

  // Read the most recent plan artefact from <cwd>/.claude/plans/. The
  // CLI's plan-mode reminder tells the model to write there (default
  // ~/.claude/plans/ + our HOME=cwd setup). Returns null if nothing
  // is found.
  async _readMostRecentPlanArtifact() {
    const plansDir = join(this.cwd, '.claude', 'plans')
    let entries
    try {
      entries = await readdir(plansDir, { withFileTypes: true })
    } catch {
      return null
    }
    let best = null
    let bestMtime = 0
    for (const ent of entries) {
      if (!ent.isFile()) continue
      if (!/\.(md|markdown)$/i.test(ent.name)) continue
      const full = join(plansDir, ent.name)
      let st
      try {
        st = await stat(full)
      } catch {
        continue
      }
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs
        best = full
      }
    }
    if (!best) return null
    try {
      return await readFile(best, 'utf8')
    } catch {
      return null
    }
  }

  // Called by AiAssistantController in response to a frontend POST to
  // /ai-assistant/permission-response. Handles two cases:
  //   - canUseTool has already fired: resolve its promise so the
  //     model's tool call returns.
  //   - canUseTool hasn't fired (model didn't reach ExitPlanMode):
  //     still honour the user's intent by flipping to bypass mode,
  //     so writes in the same query succeed without a respawn.
  async respondPermission(requestId, allow, message) {
    if (requestId !== this.activePlanRequestId) return
    this.activePlanRequestId = null
    if (allow) {
      try {
        await this.query?.setPermissionMode('bypassPermissions')
        this.permissionMode = 'bypassPermissions'
        this.emit('permission-mode', { mode: 'bypassPermissions' })
      } catch (err) {
        logger.warn({ err }, 'ai-assistant: setPermissionMode failed')
      }
    }
    const resolver = this.pendingPlanSdkResolver
    this.pendingPlanSdkResolver = null
    if (resolver) {
      resolver(
        allow
          ? { behavior: 'allow' }
          : {
              behavior: 'deny',
              message:
                message ||
                'User requested changes to the plan. Wait for their ' +
                  'next message before revising.',
            }
      )
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

    // The user typed instead of clicking the PlanCard. Treat that as
    // "request changes" so the SDK's ExitPlanMode call unblocks and
    // the model sees the user's text as feedback on its next turn.
    // (If only the FileSync hook surfaced the card, there's no SDK
    // resolver to flip and we just clear the card id.)
    if (this.activePlanRequestId) {
      this.activePlanRequestId = null
      const resolver = this.pendingPlanSdkResolver
      this.pendingPlanSdkResolver = null
      if (resolver) {
        resolver({ behavior: 'deny', message: 'User wants changes: ' + text })
      }
    }

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
    // Don't leave the SDK's canUseTool waiting on a shutdown query.
    if (this.pendingPlanSdkResolver) {
      this.pendingPlanSdkResolver({
        behavior: 'deny',
        message: 'Session ended.',
      })
      this.pendingPlanSdkResolver = null
    }
    this.activePlanRequestId = null
    this._exitPlanToolUseIds.clear()
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
