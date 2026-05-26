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
import { getJSON, postJSON, deleteJSON } from '@/infrastructure/fetch-json'
import withErrorBoundary from '@/infrastructure/error-boundary'
import claudeLogoUrl from '../assets/claude-logo.svg'

type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

type OauthStatus = {
  enabled: boolean
  connected: boolean
  account: string | null
}

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

type FileDiff = {
  kind: 'file-diff'
  path: string
  hunks: DiffHunk[]
  id: string
}

type DiffHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  content: string
}

type ImageAttachment = {
  file: File
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
  | FileDiff
  | { kind: 'file-changed'; path: string; id: string }
  | { kind: 'error'; message: string; id: string }
  | { kind: 'turn-divider'; id: string }

function newId() {
  return Math.random().toString(36).slice(2)
}

const MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Ask' },
  { value: 'plan', label: 'Plan' },
  { value: 'acceptEdits', label: 'Accept edits' },
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
  const [status, setStatus] = useState<OauthStatus | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    getJSON<OauthStatus>('/ai-assistant/oauth/status')
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, connected: false, account: null }))
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
  if (!status.connected) {
    return <ConnectClaude onConnected={() => setRefreshTick(n => n + 1)} />
  }
  return (
    <Chat
      projectId={projectId}
      account={status.account}
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
  onStop,
  onNew,
  onDisconnect,
  onToggleSessions,
}: {
  connectionState: 'loading' | 'disabled' | 'idle' | 'running' | 'error'
  account?: string | null
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
  onClose,
}: {
  sessions: SessionInfo[]
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}) {
  const now = Date.now()
  const today = new Date(now).toDateString()
  const yesterday = new Date(now - 86400000).toDateString()
  const groups: { label: string; items: SessionInfo[] }[] = []
  const buckets = new Map<string, SessionInfo[]>()
  for (const s of sessions) {
    const d = new Date(s.updatedAt).toDateString()
    if (!buckets.has(d)) buckets.set(d, [])
    buckets.get(d)!.push(s)
  }
  for (const [d, items] of buckets) {
    const label =
      d === today ? 'Today' : d === yesterday ? 'Yesterday' : d
    groups.push({ label, items })
  }
  return (
    <div className="cc-session-list">
      <div className="cc-session-list-header">
        <span>Conversations</span>
        <button type="button" className="cc-icon-btn" onClick={onClose}>✕</button>
      </div>
      {groups.map(g => (
        <div key={g.label} className="cc-session-group">
          <div className="cc-session-group-label">{g.label}</div>
          {g.items.map(s => (
            <div
              key={s.id}
              className={`cc-session-item ${s.id === activeId ? 'cc-session-item-active' : ''}`}
              onClick={() => onSelect(s.id)}
            >
              <span className="cc-session-item-title">{s.title}</span>
              <button
                type="button"
                className="cc-session-item-delete"
                onClick={e => { e.stopPropagation(); onDelete(s.id) }}
                title="Delete"
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      ))}
      {sessions.length === 0 && (
        <div className="cc-session-empty">No conversations yet</div>
      )}
    </div>
  )
}

function Chat({
  projectId,
  account,
  onDisconnect,
}: {
  projectId: string
  account: string | null
  onDisconnect: () => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<PermissionMode>('default')
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
    es.addEventListener('file-diff', (ev: MessageEvent) => {
      const d = JSON.parse(ev.data)
      append({ kind: 'file-diff', path: d.path, hunks: d.hunks || [], id: newId() })
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
  }, [projectId])

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

  const revertFile = useCallback(
    async (path: string, msgId: string) => {
      try {
        await postJSON(`/project/${projectId}/ai-assistant/revert-file`, {
          body: { path },
        })
        setMessages(curr =>
          curr.map(m =>
            m.kind === 'file-diff' && m.id === msgId
              ? { ...m, hunks: [] }
              : m
          )
        )
      } catch {}
    },
    [projectId]
  )

  const send = useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? input).trim()
      if (!text && images.length === 0) return
      setInput('')
      const sentImages = [...images]
      setImages([])
      setError(null)
      setMessages(curr => [
        ...curr,
        { kind: 'user', text, id: newId(), images: sentImages },
      ])
      setState('running')
      try {
        const body: any = { text, permissionMode: mode }
        if (sentImages.length > 0) {
          body.images = sentImages.map(img => ({
            mediaType: img.file.type,
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

  const stop = useCallback(async () => {
    try {
      await postJSON(`/project/${projectId}/ai-assistant/stop`)
      setState('idle')
    } catch {}
  }, [projectId])

  const newConversation = useCallback(async () => {
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
  }, [stop, projectId, loadSessions])

  const disconnect = useCallback(async () => {
    try {
      await postJSON('/ai-assistant/oauth/disconnect')
    } finally {
      onDisconnect()
    }
  }, [onDisconnect])

  const addImages = useCallback((fileList: FileList) => {
    const newImgs: ImageAttachment[] = []
    Array.from(fileList).forEach(file => {
      if (!file.type.startsWith('image/')) return
      const reader = new FileReader()
      reader.onload = () => {
        newImgs.push({ file, dataUrl: reader.result as string, id: newId() })
        if (newImgs.length === fileList.length) {
          setImages(prev => [...prev, ...newImgs])
        }
      }
      reader.readAsDataURL(file)
    })
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
          onSelect={(id) => {
            setSessionId(id)
            setMessages([])
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
          onClose={() => setShowSessions(false)}
        />
      )}
      <PanelHeader
        connectionState={state}
        account={account}
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
            onRevertFile={revertFile}
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
  onRevertFile,
}: {
  m: Message
  onPermissionResponse: (id: string, allow: boolean) => void
  onRevertFile: (path: string, msgId: string) => void
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
  if (m.kind === 'tool-use') return <ToolUseCard m={m} />
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
  if (m.kind === 'file-diff') {
    return (
      <FileDiffCard
        path={m.path}
        hunks={m.hunks}
        id={m.id}
        onRevert={onRevertFile}
      />
    )
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

function FileDiffCard({
  path,
  hunks,
  id,
  onRevert,
}: {
  path: string
  hunks: DiffHunk[]
  id: string
  onRevert: (path: string, msgId: string) => void
}) {
  if (hunks.length === 0) {
    return <div className="cc-file-changed">↪ edited {path}</div>
  }
  return (
    <details className="cc-diff">
      <summary>
        <span className="cc-tool-name">Edit</span>
        <span className="cc-tool-summary">{path}</span>
      </summary>
      <div className="cc-diff-body">
        {hunks.map((h, i) => (
          <pre key={i} className="cc-diff-hunk">
            {h.content}
          </pre>
        ))}
        <div className="cc-diff-actions">
          <button
            type="button"
            className="cc-btn cc-btn-accept"
            onClick={() => onRevert(path, id)}
          >
            Revert
          </button>
        </div>
      </div>
    </details>
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
    if (wantSend) {
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