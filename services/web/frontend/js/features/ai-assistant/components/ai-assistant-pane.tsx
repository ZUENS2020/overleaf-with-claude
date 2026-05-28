import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  FormEvent,
  ChangeEvent,
} from 'react'
import { marked } from 'marked'
import { useProjectContext } from '@/shared/context/project-context'
import { usePermissionsContext } from '@/features/ide-react/context/permissions-context'
import {
  getJSON,
  postJSON,
  putJSON,
  deleteJSON,
} from '@/infrastructure/fetch-json'
import withErrorBoundary from '@/infrastructure/error-boundary'
import claudeLogoUrl from '../assets/claude-logo.svg'

type PermissionMode = 'plan' | 'bypassPermissions'

type OauthStatus = {
  enabled: boolean
  connected: boolean
  account: string | null
}

const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
]

type Todo = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

type ToolUse = {
  kind: 'tool-use'
  id: string
  name: string
  input: any
  result?: string
  isError?: boolean
}

type PermissionReq = {
  kind: 'permission-request'
  id: string
  tool: string
  input: any
  description?: string
}

type ImageAttachment = {
  // `file` is absent on attachments rehydrated from a persisted
  // session — only the dataUrl is needed for display.
  file?: File
  dataUrl: string
  id: string
}

type Message =
  | { kind: 'user'; text: string; id: string; images?: ImageAttachment[] }
  | { kind: 'assistant'; text: string; id: string }
  | { kind: 'thinking'; text: string; id: string }
  | ToolUse
  | PermissionReq
  | { kind: 'todos'; id: string; todos: Todo[] }
  | { kind: 'file-changed'; path: string; id: string }
  | { kind: 'error'; message: string; id: string }
  | { kind: 'turn-divider'; id: string }

function newId() {
  return Math.random().toString(36).slice(2)
}

const MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' },
]

const SLASH_COMMANDS: { name: string; hint: string }[] = [
  { name: '/clear', hint: 'Clear the conversation' },
  { name: '/compact', hint: 'Summarize history to save context' },
  { name: '/help', hint: 'Show available commands' },
  { name: '/model', hint: 'Switch model' },
  { name: '/cost', hint: 'Show session usage / cost' },
]

const FILE_ICONS: Record<string, string> = {
  tex: 'description',
  bib: 'library_books',
  cls: 'code',
  sty: 'code',
  md: 'article',
  txt: 'note',
  json: 'data_object',
  yaml: 'data_object',
  yml: 'data_object',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  pdf: 'picture_as_pdf',
}

function fileIconFor(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return FILE_ICONS[ext] || 'insert_drive_file'
}

function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf('/')
  if (idx === -1) return { dir: '', name: path }
  return { dir: path.slice(0, idx), name: path.slice(idx + 1) }
}

marked.setOptions({ breaks: true, gfm: true })

function renderMarkdown(src: string): string {
  return marked.parse(src, { async: false }) as string
}

export const AiAssistantPane = () => {
  const { projectId } = useProjectContext()
  const { write } = usePermissionsContext()
  const [status, setStatus] = useState<OauthStatus | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [preferredModel, setPreferredModel] = useState<string>('sonnet')

  useEffect(() => {
    getJSON<OauthStatus>('/ai-assistant/oauth/status')
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, connected: false, account: null }))
    getJSON<{ preferredModel: string }>('/ai-assistant/preferences')
      .then(r => setPreferredModel(r.preferredModel || 'sonnet'))
      .catch(() => {})
  }, [refreshTick])

  if (!status) {
    return (
      <div className="cc-panel">
        <PanelHeader connectionState="loading" />
      </div>
    )
  }
  if (!status.enabled) {
    return (
      <div className="cc-panel">
        <PanelHeader connectionState="disabled" />
        <div className="cc-empty">
          <p>Claude Code is not enabled on this server.</p>
        </div>
      </div>
    )
  }
  if (!write) {
    return (
      <div className="cc-panel">
        <PanelHeader connectionState="disabled" model={preferredModel} />
        <div className="cc-empty">
          <img src={claudeLogoUrl} className="cc-logo-large" alt="" />
          <h3>Read-only access</h3>
          <p className="cc-empty-sub">
            You need edit access to use the AI assistant.
          </p>
        </div>
      </div>
    )
  }
  if (!status.connected) {
    return <ConnectClaude onConnected={() => setRefreshTick(n => n + 1)} />
  }
  return (
    <Chat
      projectId={projectId}
      account={status.account}
      preferredModel={preferredModel}
      onModelChange={async (model: string) => {
        try {
          await putJSON('/ai-assistant/preferences', { body: { preferredModel: model } })
          setPreferredModel(model)
          try {
            await postJSON(`/project/${projectId}/ai-assistant/stop`)
          } catch {}
        } catch {}
      }}
      onDisconnect={() => setRefreshTick(n => n + 1)}
    />
  )
}

type SessionInfo = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

function PanelHeader({
  connectionState,
  account,
  model,
  onStop,
  onNew,
  onDisconnect,
  onToggleSessions,
}: {
  connectionState: 'loading' | 'disabled' | 'idle' | 'running' | 'error'
  account?: string | null
  model?: string
  onStop?: () => void
  onNew?: () => void
  onDisconnect?: () => void
  onToggleSessions?: () => void
}) {
  const dotClass =
    connectionState === 'running'
      ? 'cc-dot cc-dot-running'
      : connectionState === 'error'
        ? 'cc-dot cc-dot-error'
        : 'cc-dot cc-dot-idle'
  return (
    <div className="cc-header">
      <div className="cc-header-title">
        <img src={claudeLogoUrl} className="cc-logo" alt="" />
        <span>Claude Code</span>
        {connectionState !== 'loading' && connectionState !== 'disabled' && (
          <span className={dotClass} title={connectionState} />
        )}
      </div>
      <div className="cc-header-actions">
        {account && <span className="cc-header-account">{account}</span>}
        {model && <span className="cc-header-model">{model}</span>}
        {onToggleSessions && (
          <button
            type="button"
            className="cc-icon-btn"
            onClick={onToggleSessions}
            title="Conversations"
            aria-label="Conversations"
          >
            ☰
          </button>
        )}
        {onNew && (
          <button
            type="button"
            className="cc-icon-btn"
            onClick={onNew}
            title="New conversation"
            aria-label="New conversation"
          >
            ＋
          </button>
        )}
        {onStop && (
          <button
            type="button"
            className="cc-icon-btn"
            onClick={onStop}
            title="Stop"
            aria-label="Stop"
          >
            ■
          </button>
        )}
        {onDisconnect && (
          <button
            type="button"
            className="cc-icon-btn"
            onClick={onDisconnect}
            title="Sign out"
            aria-label="Sign out"
          >
            ⎋
          </button>
        )}
      </div>
    </div>
  )
}

function ConnectClaude({ onConnected }: { onConnected: () => void }) {
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await postJSON<{ authorizeUrl: string }>(
        '/ai-assistant/oauth/start'
      )
      setAuthorizeUrl(r.authorizeUrl)
      window.open(r.authorizeUrl, '_blank', 'noopener')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const submit = useCallback(
    async (ev: FormEvent) => {
      ev.preventDefault()
      setBusy(true)
      setError(null)
      try {
        await postJSON('/ai-assistant/oauth/exchange', { body: { code } })
        onConnected()
      } catch (e: any) {
        setError(e?.message || String(e))
      } finally {
        setBusy(false)
      }
    },
    [code, onConnected]
  )

  return (
    <div className="cc-panel">
      <PanelHeader connectionState="idle" />
      <div className="cc-empty">
        <img src={claudeLogoUrl} className="cc-logo-large" alt="" />
        <h3>Connect your Claude account</h3>
        <p className="cc-empty-sub">
          You'll authorize on anthropic.com and paste the code back here.
        </p>
        {!authorizeUrl ? (
          <button
            type="button"
            className="cc-btn cc-btn-primary"
            onClick={start}
            disabled={busy}
          >
            Connect Claude
          </button>
        ) : (
          <form onSubmit={submit} className="cc-oauth-form">
            <p className="cc-empty-sub">
              After authorizing, paste the code Anthropic displays here.
            </p>
            <input
              type="text"
              className="cc-input"
              placeholder="Paste authorization code"
              value={code}
              onChange={e => setCode(e.target.value)}
              autoFocus
            />
            <div className="cc-row-gap">
              <button
                type="submit"
                className="cc-btn cc-btn-primary"
                disabled={busy || !code.trim()}
              >
                {busy ? '…' : 'Submit code'}
              </button>
              <button
                type="button"
                className="cc-btn cc-btn-ghost"
                onClick={() =>
                  authorizeUrl && window.open(authorizeUrl, '_blank', 'noopener')
                }
              >
                Reopen page
              </button>
            </div>
          </form>
        )}
        {error && <div className="cc-error">{error}</div>}
      </div>
    </div>
  )
}

function SessionList({
  sessions,
  activeId,
  onSelect,
  onDelete,
  onRename,
  onCreate,
  onClose,
}: {
  sessions: SessionInfo[]
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onCreate: () => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingId) renameInputRef.current?.select()
  }, [renamingId])

  // Newest first; search is a case-insensitive substring match on title.
  const filtered = sessions
    .slice()
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
    .filter(s =>
      query.trim() === ''
        ? true
        : s.title.toLowerCase().includes(query.trim().toLowerCase())
    )

  const commitRename = (id: string) => {
    const t = draftTitle.trim()
    if (t.length > 0) onRename(id, t)
    setRenamingId(null)
  }

  return (
    <div className="cc-session-list">
      <div className="cc-session-list-header">
        <span className="cc-session-list-eyebrow">CLAUDE CODE</span>
        <button
          type="button"
          className="cc-icon-btn"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <button
        type="button"
        className="cc-session-new"
        onClick={onCreate}
      >
        <span aria-hidden>+</span> New conversation
      </button>
      <div className="cc-session-search">
        <span className="cc-session-search-icon" aria-hidden>
          ⌕
        </span>
        <input
          type="text"
          placeholder="Search conversations…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search conversations"
        />
      </div>
      <div className="cc-session-items">
        {filtered.map(s => {
          const isActive = s.id === activeId
          const isRenaming = renamingId === s.id
          return (
            <div
              key={s.id}
              className={
                'cc-session-item' +
                (isActive ? ' cc-session-item-active' : '') +
                (isRenaming ? ' cc-session-item-renaming' : '')
              }
              onClick={() => {
                if (!isRenaming) onSelect(s.id)
              }}
            >
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  className="cc-session-rename-input"
                  value={draftTitle}
                  onChange={e => setDraftTitle(e.target.value)}
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => {
                    if (e.nativeEvent.isComposing) return
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitRename(s.id)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setRenamingId(null)
                    }
                  }}
                  onBlur={() => commitRename(s.id)}
                />
              ) : (
                <span
                  className="cc-session-item-title"
                  title={s.title}
                >
                  {s.title || 'Untitled'}
                </span>
              )}
              <span className="cc-session-item-time">
                {formatRelativeTime(s.updatedAt)}
              </span>
              <span className="cc-session-item-actions">
                <button
                  type="button"
                  className="cc-icon-btn"
                  title="Rename"
                  aria-label="Rename"
                  onClick={e => {
                    e.stopPropagation()
                    setDraftTitle(s.title || '')
                    setRenamingId(s.id)
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="cc-icon-btn"
                  title="Delete"
                  aria-label="Delete"
                  onClick={e => {
                    e.stopPropagation()
                    onDelete(s.id)
                  }}
                >
                  🗑
                </button>
              </span>
            </div>
          )
        })}
        {filtered.length === 0 && (
          <div className="cc-session-empty">
            {sessions.length === 0
              ? 'No conversations yet'
              : 'No matches'}
          </div>
        )}
      </div>
    </div>
  )
}

// Short relative-time label for session-list timestamps, matching
// what the VS Code extension uses ("just now", "5m", "3h", "5d",
// then full dates for anything older than 30 days).
function formatRelativeTime(iso: string): string {
  const t = +new Date(iso)
  if (isNaN(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm'
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h'
  if (diff < 30 * 86_400_000) return Math.floor(diff / 86_400_000) + 'd'
  return new Date(t).toLocaleDateString()
}

function Chat({
  projectId,
  account,
  preferredModel,
  onModelChange,
  onDisconnect,
}: {
  projectId: string
  account: string | null
  preferredModel: string
  onModelChange: (model: string) => void
  onDisconnect: () => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<PermissionMode>('bypassPermissions')
  const [state, setState] = useState<'idle' | 'running' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [useCtrlEnter, setUseCtrlEnter] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const [images, setImages] = useState<ImageAttachment[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [showSessions, setShowSessions] = useState(false)

  // Refs let the long-lived SSE handlers and the persist callback see
  // the latest state without re-subscribing every render.
  const sessionIdRef = useRef<string | null>(null)
  const messagesRef = useRef<Message[]>([])
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // Persist the current conversation to its session row. Strips the
  // non-serializable `file: File` field from image attachments — we
  // keep the base64 dataUrl which renders fine on reload.
  const persistMessages = useCallback(async () => {
    const sid = sessionIdRef.current
    if (!sid) return
    const serializable = messagesRef.current.map(m => {
      if (m.kind === 'user' && m.images && m.images.length > 0) {
        return {
          ...m,
          images: m.images.map(img => ({
            id: img.id,
            dataUrl: img.dataUrl,
          })),
        }
      }
      return m
    })
    try {
      await putJSON(
        `/project/${projectId}/ai-assistant/sessions/${sid}/messages`,
        { body: { messages: serializable } }
      )
    } catch {
      /* persistence is best-effort */
    }
  }, [projectId])

  const loadFiles = useCallback(async () => {
    if (files.length > 0) return
    try {
      const r = await getJSON<{ paths: string[] }>(
        `/project/${projectId}/ai-assistant/files`
      )
      setFiles(r.paths || [])
    } catch {}
  }, [files.length, projectId])

  const loadSessions = useCallback(async () => {
    try {
      const r = await getJSON<{ sessions: SessionInfo[] }>(
        `/project/${projectId}/ai-assistant/sessions`
      )
      setSessions(r.sessions || [])
    } catch {}
  }, [projectId])

  useEffect(() => { loadSessions() }, [loadSessions])

  useEffect(() => {
    const es = new EventSource(`/project/${projectId}/ai-assistant/stream`)
    const append = (m: Message) => setMessages(curr => [...curr, m])

    es.addEventListener('status', (ev: MessageEvent) => {
      const d = JSON.parse(ev.data)
      if (d.state === 'starting' || d.state === 'running') setState('running')
      else if (d.state === 'stopped') setState('idle')
    })
    es.addEventListener('assistant-message', (ev: MessageEvent) => {
      const d = JSON.parse(ev.data)
      append({ kind: 'assistant', text: d.text, id: newId() })
    })
    es.addEventListener('thinking', (ev: MessageEvent) => {
      const d = JSON.parse(ev.data)
      if (d.text) append({ kind: 'thinking', text: d.text, id: newId() })
    })
    es.addEventListener('tool-use', (ev: MessageEvent) => {
      const d = JSON.parse(ev.data)
      append({ kind: 'tool-use', id: d.id, name: d.name, input: d.input })
    })
    es.addEventListener('tool-result', (ev: MessageEvent) => {
      const d = JSON.parse(ev.data)
      setMessages(curr =>
        curr.map(m =>
          m.kind === 'tool-use' && m.id === d.id
            ? {
                ...m,
                result:
                  typeof d.output === 'string'
                    ? d.output
                    : JSON.stringify(d.output),
                isError: d.isError,
              }
            : m
        )
      )
    })
    es.addEventListener('todos', (ev: MessageEvent) => {
      const d = JSON.parse(ev.data)
      append({ kind: 'todos', id: newId(), todos: d.todos || [] })
    })
    es.addEventListener('file-changed', (ev: MessageEvent) => {
      const d = JSON.parse(ev.data)
      append({ kind: 'file-changed', path: d.path, id: newId() })
    })
    es.addEventListener('permission-request', (ev: MessageEvent) => {
      const d = JSON.parse(ev.data)
      append({
        kind: 'permission-request',
        id: d.id,
        tool: d.tool,
        input: d.input,
        description: d.description,
      })
    })
    es.addEventListener('turn-end', () => {
      setState('idle')
      append({ kind: 'turn-divider', id: newId() })
      // Persist the conversation when each turn completes; the next
      // tick lets the divider append before we snapshot.
      setTimeout(() => persistMessages(), 0)
    })
    es.addEventListener('error', (ev: MessageEvent) => {
      const data = (ev as any).data
      if (data) {
        try {
          const d = JSON.parse(data)
          append({ kind: 'error', message: d.message, id: newId() })
          setState('error')
        } catch {}
      }
    })
    es.onerror = () => setState('idle')
    return () => es.close()
  }, [projectId, persistMessages])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const respondPermission = useCallback(
    async (id: string, allow: boolean) => {
      await postJSON(`/project/${projectId}/ai-assistant/permission-response`, {
        body: { id, allow },
      })
      setMessages(curr =>
        curr.filter(m => !(m.kind === 'permission-request' && m.id === id))
      )
    },
    [projectId]
  )

  const send = useCallback(
    async (opts?: { text?: string; modeOverride?: PermissionMode }) => {
      const text = (opts?.text ?? input).trim()
      if (!text && images.length === 0) return
      const effectiveMode = opts?.modeOverride ?? mode
      // Reflect a one-shot mode override in the composer UI too, so the
      // mode pills don't lie about what's actually in flight.
      if (opts?.modeOverride && opts.modeOverride !== mode) {
        setMode(opts.modeOverride)
      }
      if (opts?.text === undefined) setInput('')
      const sentImages = [...images]
      setImages([])
      setError(null)
      setMessages(curr => [
        ...curr,
        { kind: 'user', text, id: newId(), images: sentImages },
      ])
      setState('running')
      try {
        const body: any = { text, permissionMode: effectiveMode }
        if (sentImages.length > 0) {
          body.images = sentImages.map(img => ({
            mediaType: img.file?.type || 'image/png',
            data: img.dataUrl.split(',')[1],
          }))
        }
        await postJSON(`/project/${projectId}/ai-assistant/message`, {
          body,
        })
        if (!sessionId) {
          try {
            const sr = await postJSON(`/project/${projectId}/ai-assistant/sessions`, {
              body: { title: text.slice(0, 80) },
            })
            setSessionId(sr.id)
            loadSessions()
          } catch {}
        } else if (messages.length === 0) {
          postJSON(
            `/project/${projectId}/ai-assistant/sessions/${sessionId}/rename`,
            { body: { title: text.slice(0, 80) } }
          ).catch(() => {})
          loadSessions()
        }
      } catch (e: any) {
        setError(e?.message || String(e))
        setState('error')
      }
    },
    [input, projectId, mode, images, sessionId, messages.length, loadSessions]
  )

  // Plan-mode interactions: when Claude emits ExitPlanMode (which the
  // PlanCard renders inline), the user can approve it (switch to
  // bypass + restart proc + tell Claude to implement) or request
  // changes (drop a templated revision prompt into the composer).
  const approvePlan = useCallback(
    (planText: string) => {
      send({
        text:
          'I approve this plan. Please implement it now.\n\n' +
          '--- Plan ---\n' +
          planText,
        modeOverride: 'bypassPermissions',
      })
    },
    [send]
  )
  const modifyPlan = useCallback((planText: string) => {
    setInput(
      'Please revise the plan. Current proposal:\n\n' +
        planText +
        '\n\nChanges I want: '
    )
    composerRef.current?.focus()
  }, [])

  const stop = useCallback(async () => {
    try {
      await postJSON(`/project/${projectId}/ai-assistant/stop`)
      setState('idle')
    } catch {}
  }, [projectId])

  const newConversation = useCallback(async () => {
    // Snapshot the outgoing conversation before clearing.
    await persistMessages()
    await stop()
    setMessages([])
    try {
      const r = await postJSON(`/project/${projectId}/ai-assistant/sessions`, {
        body: { title: 'New conversation' },
      })
      setSessionId(r.id)
      loadSessions()
    } catch {
      setSessionId(null)
    }
  }, [stop, projectId, loadSessions, persistMessages])

  const disconnect = useCallback(async () => {
    try {
      await postJSON('/ai-assistant/oauth/disconnect')
    } finally {
      onDisconnect()
    }
  }, [onDisconnect])

  const addImages = useCallback(async (fileList: FileList) => {
    // Read each image to a data URL in parallel. The previous version
    // tracked completion with `newImgs.length === fileList.length`,
    // which silently deadlocked when any file was filtered out (non-
    // image) or errored — the setImages call then never fired.
    const reads = Array.from(fileList)
      .filter(f => f.type.startsWith('image/'))
      .map(
        file =>
          new Promise<ImageAttachment | null>(resolve => {
            const reader = new FileReader()
            reader.onload = () =>
              resolve({
                file,
                dataUrl: reader.result as string,
                id: newId(),
              })
            reader.onerror = () => resolve(null)
            reader.readAsDataURL(file)
          })
      )
    const done = (await Promise.all(reads)).filter(
      (x): x is ImageAttachment => x !== null
    )
    if (done.length > 0) setImages(prev => [...prev, ...done])
  }, [])

  const removeImage = useCallback((id: string) => {
    setImages(prev => prev.filter(img => img.id !== id))
  }, [])

  return (
    <div className="cc-panel">
      {showSessions && (
        <SessionList
          sessions={sessions}
          activeId={sessionId}
          onSelect={async id => {
            // Persist the OUTGOING session before swapping. The
            // backend keeps ONE CLI subprocess per (user, project), so
            // we also have to kill it — otherwise the next message
            // goes to the previous conversation's in-CLI context.
            await persistMessages()
            try {
              await postJSON(`/project/${projectId}/ai-assistant/stop`)
            } catch {}
            setState('idle')
            setSessionId(id)
            // Load the chosen session's saved transcript.
            try {
              const r = await getJSON<{ messages: Message[] }>(
                `/project/${projectId}/ai-assistant/sessions/${id}/messages`
              )
              setMessages(r.messages || [])
            } catch {
              setMessages([])
            }
            setShowSessions(false)
          }}
          onDelete={async (id) => {
            try {
              await deleteJSON(`/project/${projectId}/ai-assistant/sessions/${id}`)
              if (id === sessionId) {
                setSessionId(null)
                setMessages([])
              }
              loadSessions()
            } catch {}
          }}
          onRename={async (id, title) => {
            try {
              await postJSON(
                `/project/${projectId}/ai-assistant/sessions/${id}/rename`,
                { body: { title } }
              )
              loadSessions()
            } catch {}
          }}
          onCreate={async () => {
            await newConversation()
            setShowSessions(false)
          }}
          onClose={() => setShowSessions(false)}
        />
      )}
      <PanelHeader
        connectionState={state}
        account={account}
        model={preferredModel}
        onNew={messages.length > 0 || state === 'running' ? newConversation : undefined}
        onStop={state === 'running' ? stop : undefined}
        onDisconnect={disconnect}
        onToggleSessions={() => setShowSessions(v => !v)}
      />
      <div className="cc-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="cc-welcome">
            <img src={claudeLogoUrl} className="cc-logo-large" alt="" />
            <p className="cc-welcome-text">
              Ask Claude to edit files, run commands, or explain your project.
            </p>
            <p className="cc-welcome-hint">
              Type <code>@</code> to mention a file, <code>/</code> for commands.
            </p>
          </div>
        )}
        {messages.map(m => (
          <MessageNode
            key={m.id}
            m={m}
            onPermissionResponse={respondPermission}
            onPlanApprove={approvePlan}
            onPlanModify={modifyPlan}
          />
        ))}
      </div>
      <Composer
        input={input}
        setInput={setInput}
        files={files}
        ensureFilesLoaded={loadFiles}
        mode={mode}
        setMode={setMode}
        preferredModel={preferredModel}
        onModelChange={onModelChange}
        useCtrlEnter={useCtrlEnter}
        toggleCtrlEnter={() => setUseCtrlEnter(v => !v)}
        onSend={() => send()}
        composerRef={composerRef}
        fileInputRef={fileInputRef}
        images={images}
        onAddImages={addImages}
        onRemoveImage={removeImage}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={e => {
          if (e.target.files && e.target.files.length > 0) addImages(e.target.files)
          e.target.value = ''
        }}
      />
      {error && <div className="cc-error">{error}</div>}
      {state === 'running' && <div className="cc-status">Claude is working…</div>}
    </div>
  )
}

function MessageNode({
  m,
  onPermissionResponse,
  onPlanApprove,
  onPlanModify,
}: {
  m: Message
  onPermissionResponse: (id: string, allow: boolean) => void
  onPlanApprove: (plan: string) => void
  onPlanModify: (plan: string) => void
}) {
  if (m.kind === 'turn-divider') return <div className="cc-turn-divider" />
  if (m.kind === 'user') {
    return (
      <div className="cc-msg cc-msg-user">
        {m.text}
        {m.images && m.images.length > 0 && (
          <div className="cc-msg-images">
            {m.images.map(img => (
              <img key={img.id} src={img.dataUrl} className="cc-msg-thumb" alt="" />
            ))}
          </div>
        )}
      </div>
    )
  }
  if (m.kind === 'assistant') {
    return (
      <div className="cc-msg cc-msg-assistant">
        <img src={claudeLogoUrl} className="cc-msg-avatar" alt="" />
        <div
          className="cc-msg-body cc-markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
        />
      </div>
    )
  }
  if (m.kind === 'thinking') {
    return (
      <details className="cc-thinking">
        <summary>Thought</summary>
        <div
          className="cc-thinking-body cc-markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
        />
      </details>
    )
  }
  if (m.kind === 'tool-use') {
    // Plan-mode produces a single ExitPlanMode tool call carrying the
    // full plan as markdown. Render it as an interactive card with
    // approve / modify actions instead of a raw JSON dump.
    if (m.name === 'ExitPlanMode') {
      const plan =
        typeof m.input?.plan === 'string'
          ? m.input.plan
          : JSON.stringify(m.input, null, 2)
      return (
        <PlanCard
          plan={plan}
          onApprove={() => onPlanApprove(plan)}
          onModify={() => onPlanModify(plan)}
        />
      )
    }
    return <ToolUseCard m={m} />
  }
  if (m.kind === 'permission-request') {
    return (
      <PermissionCard
        id={m.id}
        tool={m.tool}
        input={m.input}
        description={m.description}
        onRespond={onPermissionResponse}
      />
    )
  }
  if (m.kind === 'todos') return <TodosCard todos={m.todos} />
  if (m.kind === 'file-changed') {
    return <div className="cc-file-changed">↪ edited {m.path}</div>
  }
  if (m.kind === 'error') return <div className="cc-error">{m.message}</div>
  return null
}

function ToolUseCard({ m }: { m: ToolUse }) {
  const summary = summarizeToolInput(m.name, m.input)
  const done = m.result !== undefined
  const status = done ? (m.isError ? 'error' : 'done') : 'running'
  return (
    <details className={`cc-tool cc-tool-${status}`}>
      <summary>
        <span className="cc-tool-name">{m.name}</span>
        {summary && <span className="cc-tool-summary">{summary}</span>}
        <span className={`cc-dot cc-dot-${status}`} />
      </summary>
      <div className="cc-tool-body">
        <div className="cc-tool-label">Input</div>
        <pre className="cc-code">{JSON.stringify(m.input, null, 2)}</pre>
        {m.result !== undefined && (
          <>
            <div className="cc-tool-label">{m.isError ? 'Error' : 'Result'}</div>
            <pre className="cc-code">{m.result}</pre>
          </>
        )}
      </div>
    </details>
  )
}

function PermissionCard({
  id,
  tool,
  input,
  description,
  onRespond,
}: {
  id: string
  tool: string
  input: any
  description?: string
  onRespond: (id: string, allow: boolean) => void
}) {
  const summary = summarizeToolInput(tool, input)
  return (
    <div className="cc-permission">
      <div className="cc-permission-header">
        <span className="cc-tool-name">{tool}</span>
        {summary && <span className="cc-permission-path">{summary}</span>}
      </div>
      {description && (
        <div className="cc-permission-desc">{description}</div>
      )}
      <details className="cc-permission-details">
        <summary>Show input</summary>
        <pre className="cc-code">{JSON.stringify(input, null, 2)}</pre>
      </details>
      <div className="cc-permission-actions">
        <button
          type="button"
          className="cc-btn cc-btn-accept"
          onClick={() => onRespond(id, true)}
        >
          Allow
        </button>
        <button
          type="button"
          className="cc-btn cc-btn-deny"
          onClick={() => onRespond(id, false)}
        >
          Deny
        </button>
      </div>
    </div>
  )
}

function PlanCard({
  plan,
  onApprove,
  onModify,
}: {
  plan: string
  onApprove: () => void
  onModify: () => void
}) {
  // Once the user acts on a plan we lock the buttons so they can't
  // accidentally re-fire approval / modify on the same card.
  const [acted, setActed] = useState<'approve' | 'modify' | null>(null)
  return (
    <div className="cc-plan">
      <div className="cc-plan-header">
        <span className="cc-plan-icon" aria-hidden>
          📋
        </span>
        <span className="cc-plan-title">Proposed plan</span>
        <span className="cc-plan-mode">plan mode</span>
      </div>
      <div
        className="cc-plan-body cc-markdown"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(plan) }}
      />
      <div className="cc-plan-actions">
        <button
          type="button"
          className="cc-btn cc-btn-accept"
          disabled={acted !== null}
          onClick={() => {
            setActed('approve')
            onApprove()
          }}
        >
          {acted === 'approve' ? 'Approving…' : 'Approve & implement'}
        </button>
        <button
          type="button"
          className="cc-btn cc-btn-deny"
          disabled={acted !== null}
          onClick={() => {
            setActed('modify')
            onModify()
          }}
        >
          Request changes
        </button>
      </div>
      {acted === 'modify' && (
        <div className="cc-plan-hint">
          Edit the prompt below to describe the changes you want, then send.
        </div>
      )}
    </div>
  )
}

function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  if (typeof input.command === 'string') {
    const c = input.command as string
    return c.length > 64 ? c.slice(0, 64) + '…' : c
  }
  if (typeof input.pattern === 'string') return input.pattern
  if (typeof input.query === 'string') return input.query
  if (typeof input.url === 'string') return input.url
  return ''
}

function TodosCard({ todos }: { todos: Todo[] }) {
  return (
    <div className="cc-todos">
      {todos.map((t, i) => (
        <div key={i} className={`cc-todo cc-todo-${t.status}`}>
          <span className="cc-todo-icon">
            {t.status === 'completed'
              ? '✓'
              : t.status === 'in_progress'
                ? '▶'
                : '○'}
          </span>
          <span className="cc-todo-text">
            {t.status === 'in_progress' && t.activeForm
              ? t.activeForm
              : t.content}
          </span>
        </div>
      ))}
    </div>
  )
}

type PickerKind = 'file' | 'slash' | null
type PickerState = {
  kind: PickerKind
  triggerIdx: number
  query: string
  cursor: number
}

function Composer({
  input,
  setInput,
  files,
  ensureFilesLoaded,
  mode,
  setMode,
  preferredModel,
  onModelChange,
  useCtrlEnter,
  toggleCtrlEnter,
  onSend,
  composerRef,
  fileInputRef,
  images,
  onAddImages,
  onRemoveImage,
}: {
  input: string
  setInput: (s: string) => void
  files: string[]
  ensureFilesLoaded: () => void
  mode: PermissionMode
  setMode: (m: PermissionMode) => void
  preferredModel: string
  onModelChange: (m: string) => void
  useCtrlEnter: boolean
  toggleCtrlEnter: () => void
  onSend: () => void
  composerRef: React.RefObject<HTMLTextAreaElement>
  fileInputRef: React.RefObject<HTMLInputElement>
  images: ImageAttachment[]
  onAddImages: (fileList: FileList) => void
  onRemoveImage: (id: string) => void
}) {
  const [picker, setPicker] = useState<PickerState>({
    kind: null,
    triggerIdx: -1,
    query: '',
    cursor: 0,
  })

  const recomputePicker = useCallback(
    (value: string, caretPos: number) => {
      let i = caretPos - 1
      let triggerIdx = -1
      let kind: PickerKind = null
      while (i >= 0) {
        const ch = value[i]
        if (ch === '\n' || ch === ' ' || ch === '\t') break
        if (ch === '@' || ch === '/') {
          const before = i === 0 ? '' : value[i - 1]
          if (i === 0 || before === ' ' || before === '\n' || before === '\t') {
            triggerIdx = i
            kind = ch === '@' ? 'file' : 'slash'
          }
          break
        }
        i--
      }
      if (kind === null) {
        setPicker({ kind: null, triggerIdx: -1, query: '', cursor: 0 })
        return
      }
      const query = value.slice(triggerIdx + 1, caretPos)
      setPicker({ kind, triggerIdx, query, cursor: 0 })
      if (kind === 'file') ensureFilesLoaded()
    },
    [ensureFilesLoaded]
  )

  const items = useMemo(() => {
    if (picker.kind === 'file') {
      const q = picker.query.toLowerCase()
      const filtered = files
        .filter(p => p.toLowerCase().includes(q))
        .slice(0, 8)
      return filtered.map(p => {
        const { dir, name } = splitPath(p)
        const icon = fileIconFor(p)
        return { value: p, hint: dir, icon }
      })
    }
    if (picker.kind === 'slash') {
      const q = picker.query.toLowerCase()
      return SLASH_COMMANDS.filter(c =>
        c.name.slice(1).toLowerCase().startsWith(q)
      ).map(c => ({ value: c.name, hint: c.hint, icon: 'terminal' }))
    }
    return []
  }, [picker.kind, picker.query, files])

  const applyPick = (chosen: string) => {
    if (picker.kind === null) return
    const before = input.slice(0, picker.triggerIdx)
    const after = input.slice(picker.triggerIdx + 1 + picker.query.length)
    const insertion =
      picker.kind === 'file' ? `@${chosen} ` : `${chosen} `
    const next = before + insertion + after
    setInput(next)
    setPicker({ kind: null, triggerIdx: -1, query: '', cursor: 0 })
    requestAnimationFrame(() => {
      const ta = composerRef.current
      if (ta) {
        const pos = before.length + insertion.length
        ta.selectionStart = ta.selectionEnd = pos
        ta.focus()
      }
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (picker.kind && items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPicker(p => ({ ...p, cursor: (p.cursor + 1) % items.length }))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPicker(p => ({
          ...p,
          cursor: (p.cursor - 1 + items.length) % items.length,
        }))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applyPick(items[picker.cursor].value)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setPicker({ kind: null, triggerIdx: -1, query: '', cursor: 0 })
        return
      }
    }
    const wantSend = useCtrlEnter
      ? e.key === 'Enter' && (e.ctrlKey || e.metaKey)
      : e.key === 'Enter' && !e.shiftKey
    if (wantSend && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onSend()
    }
  }

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    setInput(v)
    recomputePicker(v, e.target.selectionStart || 0)
  }

  return (
    <div className="cc-composer">
      <div className="cc-mode-row">
        {MODE_OPTIONS.map(o => (
          <button
            key={o.value}
            type="button"
            className={`cc-mode-card ${mode === o.value ? 'cc-mode-card-active' : ''}`}
            onClick={() => setMode(o.value)}
          >
            <span className="cc-mode-card-label">{o.label}</span>
          </button>
        ))}
        <select
          className="cc-model-select"
          value={preferredModel}
          onChange={e => onModelChange(e.target.value)}
          title="Model"
        >
          {MODEL_OPTIONS.map(m => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </div>
      {images.length > 0 && (
        <div className="cc-attachments">
          {images.map(img => (
            <div key={img.id} className="cc-attachment">
              <img src={img.dataUrl} className="cc-attachment-thumb" alt="" />
              <button
                type="button"
                className="cc-attachment-remove"
                onClick={() => onRemoveImage(img.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="cc-composer-inner">
        {picker.kind && items.length > 0 && (
          <div className="cc-picker">
            {items.map((it, i) => (
              <button
                type="button"
                key={it.value}
                className={`cc-picker-item ${i === picker.cursor ? 'cc-picker-item-active' : ''}`}
                onClick={() => applyPick(it.value)}
                onMouseEnter={() =>
                  setPicker(p => ({ ...p, cursor: i }))
                }
              >
                <span className="material-symbols cc-picker-icon">{it.icon}</span>
                <span className="cc-picker-text">
                  <span className="cc-picker-name">{it.value.split('/').pop()}</span>
                  {it.hint && <span className="cc-picker-hint">{it.hint}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={composerRef}
          value={input}
          onChange={onChange}
          placeholder={
            useCtrlEnter
              ? 'Ask Claude… (⌘+Enter to send, @ for files, / for commands)'
              : 'Ask Claude… (@ for files, / for commands)'
          }
          rows={3}
          onKeyDown={onKeyDown}
          className="cc-textarea"
        />
        <div className="cc-composer-actions">
          <button
            type="button"
            className="cc-icon-btn cc-icon-btn-sm"
            onClick={() => fileInputRef.current?.click()}
            title="Attach image"
            aria-label="Attach image"
          >
            📎
          </button>
          <button
            type="button"
            className="cc-icon-btn cc-icon-btn-sm"
            onClick={toggleCtrlEnter}
            title={
              useCtrlEnter
                ? 'Send on Enter (currently ⌘+Enter)'
                : 'Send on ⌘+Enter (currently Enter)'
            }
          >
            {useCtrlEnter ? '⌘↵' : '↵'}
          </button>
          <button
            type="button"
            className="cc-btn cc-btn-primary cc-btn-send"
            onClick={onSend}
            disabled={!input.trim() && images.length === 0}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

export default withErrorBoundary(AiAssistantPane, () => (
  <div className="cc-error">Failed to load AI assistant</div>
))