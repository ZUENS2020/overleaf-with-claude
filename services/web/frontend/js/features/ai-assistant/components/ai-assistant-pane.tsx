import { useCallback, useEffect, useRef, useState, FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectContext } from '@/shared/context/project-context'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'
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

type Message =
  | { kind: 'user'; text: string; id: string }
  | { kind: 'assistant'; text: string; id: string }
  | { kind: 'thinking'; text: string; id: string }
  | ToolUse
  | { kind: 'todos'; id: string; todos: Todo[] }
  | { kind: 'file-changed'; path: string; id: string }
  | { kind: 'error'; message: string; id: string }
  | { kind: 'turn-divider'; id: string }

function newId() {
  return Math.random().toString(36).slice(2)
}

const MODE_OPTIONS: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Default', hint: 'Ask before edits' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Auto-accept file edits' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Skip all checks' },
]

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

function PanelHeader({
  connectionState,
  account,
  onStop,
  onDisconnect,
}: {
  connectionState: 'loading' | 'disabled' | 'idle' | 'running' | 'error'
  account?: string | null
  onStop?: () => void
  onDisconnect?: () => void
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
  const listRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

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
        } catch {
          /* heartbeat */
        }
      }
    })
    es.onerror = () => setState('idle')
    return () => es.close()
  }, [projectId])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const send = useCallback(
    async (ev?: FormEvent) => {
      ev?.preventDefault()
      const text = input.trim()
      if (!text) return
      setInput('')
      setError(null)
      setMessages(curr => [...curr, { kind: 'user', text, id: newId() }])
      setState('running')
      try {
        await postJSON(`/project/${projectId}/ai-assistant/message`, {
          body: { text, permissionMode: mode },
        })
      } catch (e: any) {
        setError(e?.message || String(e))
        setState('error')
      }
    },
    [input, projectId, mode]
  )

  const stop = useCallback(async () => {
    try {
      await postJSON(`/project/${projectId}/ai-assistant/stop`)
      setState('idle')
    } catch {}
  }, [projectId])

  const disconnect = useCallback(async () => {
    try {
      await postJSON('/ai-assistant/oauth/disconnect')
    } finally {
      onDisconnect()
    }
  }, [onDisconnect])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const wantSend = useCtrlEnter
      ? e.key === 'Enter' && (e.ctrlKey || e.metaKey)
      : e.key === 'Enter' && !e.shiftKey
    if (wantSend) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="cc-panel">
      <PanelHeader
        connectionState={state}
        account={account}
        onStop={state === 'running' ? stop : undefined}
        onDisconnect={disconnect}
      />
      <div className="cc-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="cc-welcome">
            <img src={claudeLogoUrl} className="cc-logo-large" alt="" />
            <p className="cc-welcome-text">
              Ask Claude to edit files, run commands, or explain your project.
            </p>
          </div>
        )}
        {messages.map(m => (
          <MessageNode key={m.id} m={m} />
        ))}
      </div>
      <Composer
        input={input}
        setInput={setInput}
        mode={mode}
        setMode={setMode}
        useCtrlEnter={useCtrlEnter}
        toggleCtrlEnter={() => setUseCtrlEnter(v => !v)}
        onSend={send}
        onKeyDown={onKeyDown}
        composerRef={composerRef}
        disabled={state === 'running'}
      />
      {error && <div className="cc-error">{error}</div>}
      {state === 'running' && <div className="cc-status">Claude is working…</div>}
    </div>
  )
}

function MessageNode({ m }: { m: Message }) {
  if (m.kind === 'turn-divider') return <div className="cc-turn-divider" />
  if (m.kind === 'user') {
    return <div className="cc-msg cc-msg-user">{m.text}</div>
  }
  if (m.kind === 'assistant') {
    return (
      <div className="cc-msg cc-msg-assistant">
        <img src={claudeLogoUrl} className="cc-msg-avatar" alt="" />
        <div className="cc-msg-body">{m.text}</div>
      </div>
    )
  }
  if (m.kind === 'thinking') {
    return (
      <details className="cc-thinking">
        <summary>Thought</summary>
        <div className="cc-thinking-body">{m.text}</div>
      </details>
    )
  }
  if (m.kind === 'tool-use') {
    return <ToolUseCard m={m} />
  }
  if (m.kind === 'todos') {
    return <TodosCard todos={m.todos} />
  }
  if (m.kind === 'file-changed') {
    return <div className="cc-file-changed">↪ edited {m.path}</div>
  }
  if (m.kind === 'error') {
    return <div className="cc-error">{m.message}</div>
  }
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

function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  // Heuristics matching common tool input shapes.
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

function Composer({
  input,
  setInput,
  mode,
  setMode,
  useCtrlEnter,
  toggleCtrlEnter,
  onSend,
  onKeyDown,
  composerRef,
  disabled,
}: {
  input: string
  setInput: (s: string) => void
  mode: PermissionMode
  setMode: (m: PermissionMode) => void
  useCtrlEnter: boolean
  toggleCtrlEnter: () => void
  onSend: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  composerRef: React.RefObject<HTMLTextAreaElement>
  disabled: boolean
}) {
  return (
    <div className="cc-composer">
      <div className="cc-mode-row">
        {MODE_OPTIONS.map(o => (
          <button
            key={o.value}
            type="button"
            className={`cc-mode-pill ${mode === o.value ? 'cc-mode-pill-active' : ''}`}
            onClick={() => setMode(o.value)}
            title={o.hint}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="cc-composer-inner">
        <textarea
          ref={composerRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={
            useCtrlEnter ? 'Ask Claude… (⌘+Enter to send)' : 'Ask Claude…'
          }
          rows={3}
          onKeyDown={onKeyDown}
          className="cc-textarea"
        />
        <div className="cc-composer-actions">
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
            disabled={!input.trim()}
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
