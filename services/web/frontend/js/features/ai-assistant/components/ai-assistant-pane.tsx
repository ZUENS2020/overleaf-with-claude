import { useCallback, useEffect, useRef, useState, FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import RailPanelHeader from '@/features/ide-react/components/rail/rail-panel-header'
import { useProjectContext } from '@/shared/context/project-context'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'
import withErrorBoundary from '@/infrastructure/error-boundary'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'

type OauthStatus = {
  enabled: boolean
  connected: boolean
  account: string | null
}

type Message =
  | { kind: 'user'; text: string; id: string }
  | { kind: 'assistant'; text: string; id: string }
  | {
      kind: 'tool-use'
      id: string
      name: string
      input: any
      result?: string
      isError?: boolean
    }
  | { kind: 'file-changed'; path: string; id: string }
  | { kind: 'error'; message: string; id: string }

function newId() {
  return Math.random().toString(36).slice(2)
}

export const AiAssistantPane = () => {
  const { t } = useTranslation()
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
      <div className="ai-assistant-panel">
        <RailPanelHeader title={t('ai_assistant')} />
      </div>
    )
  }
  if (!status.enabled) {
    return (
      <div className="ai-assistant-panel">
        <RailPanelHeader title={t('ai_assistant')} />
        <div className="ai-assistant-start">
          <p>{t('ai_assistant_disabled')}</p>
        </div>
      </div>
    )
  }
  if (!status.connected) {
    return (
      <ConnectClaude
        onConnected={() => setRefreshTick(n => n + 1)}
      />
    )
  }
  return (
    <Chat
      projectId={projectId}
      account={status.account}
      onDisconnect={() => setRefreshTick(n => n + 1)}
    />
  )
}

function ConnectClaude({ onConnected }: { onConnected: () => void }) {
  const { t } = useTranslation()
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
    <div className="ai-assistant-panel">
      <RailPanelHeader title={t('ai_assistant')} />
      <div className="ai-assistant-start">
        <h3>{t('ai_assistant_connect_title')}</h3>
        <p>{t('ai_assistant_connect_intro')}</p>
        {!authorizeUrl ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={start}
            disabled={busy}
          >
            {t('ai_assistant_connect')}
          </button>
        ) : (
          <form onSubmit={submit} className="ai-assistant-oauth-form">
            <p className="small">{t('ai_assistant_paste_code_hint')}</p>
            <input
              type="text"
              className="form-control"
              placeholder={t('ai_assistant_code_placeholder')}
              value={code}
              onChange={e => setCode(e.target.value)}
              autoFocus
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !code.trim()}
            >
              {busy ? '…' : t('ai_assistant_submit_code')}
            </button>
            <button
              type="button"
              className="btn btn-link btn-sm"
              onClick={() => window.open(authorizeUrl, '_blank', 'noopener')}
            >
              {t('ai_assistant_reopen_authorize')}
            </button>
          </form>
        )}
        {error && <div className="ai-assistant-error">{error}</div>}
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
  const { t } = useTranslation()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Open the SSE stream once per project.
  useEffect(() => {
    const es = new EventSource(
      `/project/${projectId}/ai-assistant/stream`
    )
    const append = (m: Message) => setMessages(curr => [...curr, m])

    es.addEventListener('status', (ev: MessageEvent) => {
      const d = JSON.parse(ev.data)
      setStreaming(d.state === 'starting' || d.state === 'running')
    })
    es.addEventListener('user-message', (ev: MessageEvent) => {
      // server echoes; ignore — we already added it locally on send.
    })
    es.addEventListener('assistant-message', (ev: MessageEvent) => {
      const d = JSON.parse(ev.data)
      append({ kind: 'assistant', text: d.text, id: newId() })
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
    es.addEventListener('file-changed', (ev: MessageEvent) => {
      const d = JSON.parse(ev.data)
      append({ kind: 'file-changed', path: d.path, id: newId() })
    })
    es.addEventListener('turn-end', () => {})
    es.addEventListener('error', (ev: MessageEvent) => {
      const data = (ev as any).data
      if (data) {
        try {
          const d = JSON.parse(data)
          append({ kind: 'error', message: d.message, id: newId() })
        } catch {
          /* heartbeat error */
        }
      }
    })
    es.onerror = () => {
      setStreaming(false)
    }
    return () => es.close()
  }, [projectId])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const send = useCallback(
    async (ev: FormEvent) => {
      ev.preventDefault()
      const text = input.trim()
      if (!text) return
      setInput('')
      setError(null)
      setMessages(curr => [...curr, { kind: 'user', text, id: newId() }])
      try {
        await postJSON(`/project/${projectId}/ai-assistant/message`, {
          body: { text },
        })
      } catch (e: any) {
        setError(e?.message || String(e))
      }
    },
    [input, projectId]
  )

  const stop = useCallback(async () => {
    try {
      await postJSON(`/project/${projectId}/ai-assistant/stop`)
    } catch {}
  }, [projectId])

  const disconnect = useCallback(async () => {
    try {
      await postJSON('/ai-assistant/oauth/disconnect')
    } finally {
      onDisconnect()
    }
  }, [onDisconnect])

  return (
    <div className="ai-assistant-panel">
      <RailPanelHeader
        title={t('ai_assistant')}
        actions={
          <>
            <OLTooltip
              id="ai-assistant-stop"
              description={t('ai_assistant_stop_session')}
              overlayProps={{ placement: 'bottom' }}
            >
              <OLIconButton
                onClick={stop}
                className="rail-panel-header-button-subdued"
                icon="stop_circle"
                accessibilityLabel={t('ai_assistant_stop_session')}
                size="sm"
              />
            </OLTooltip>
            <OLTooltip
              id="ai-assistant-disconnect"
              description={t('ai_assistant_disconnect')}
              overlayProps={{ placement: 'bottom' }}
            >
              <OLIconButton
                onClick={disconnect}
                className="rail-panel-header-button-subdued"
                icon="logout"
                accessibilityLabel={t('ai_assistant_disconnect')}
                size="sm"
              />
            </OLTooltip>
          </>
        }
      />
      {account && (
        <div className="ai-assistant-account">
          {t('ai_assistant_connected_as', { account })}
        </div>
      )}
      <div className="ai-assistant-messages" ref={listRef}>
        {messages.map(m => {
          if (m.kind === 'user') {
            return (
              <div key={m.id} className="ai-msg ai-msg-user">
                {m.text}
              </div>
            )
          }
          if (m.kind === 'assistant') {
            return (
              <div key={m.id} className="ai-msg ai-msg-assistant">
                {m.text}
              </div>
            )
          }
          if (m.kind === 'tool-use') {
            return (
              <details key={m.id} className="ai-msg ai-msg-tool">
                <summary>
                  {m.name}
                  {m.isError ? ' (error)' : ''}
                </summary>
                <pre className="ai-msg-tool-input">
                  {JSON.stringify(m.input, null, 2)}
                </pre>
                {m.result && (
                  <pre className="ai-msg-tool-result">{m.result}</pre>
                )}
              </details>
            )
          }
          if (m.kind === 'file-changed') {
            return (
              <div key={m.id} className="ai-msg ai-msg-file">
                {t('ai_assistant_file_edited', { path: m.path })}
              </div>
            )
          }
          if (m.kind === 'error') {
            return (
              <div key={m.id} className="ai-msg ai-msg-error">
                {m.message}
              </div>
            )
          }
          return null
        })}
      </div>
      <form onSubmit={send} className="ai-assistant-composer">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={t('ai_assistant_prompt_placeholder')}
          rows={2}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(e as any)
            }
          }}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!input.trim()}
        >
          {t('ai_assistant_send')}
        </button>
      </form>
      {error && <div className="ai-assistant-error">{error}</div>}
      {streaming && (
        <div className="ai-assistant-status">
          {t('ai_assistant_thinking')}
        </div>
      )}
    </div>
  )
}

export default withErrorBoundary(AiAssistantPane, () => (
  <div className="ai-assistant-error">Failed to load AI assistant</div>
))
