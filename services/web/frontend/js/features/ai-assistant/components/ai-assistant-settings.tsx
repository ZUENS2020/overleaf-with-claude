import { useState, useEffect, useCallback, FormEvent } from 'react'
import {
  getJSON,
  postJSON,
} from '@/infrastructure/fetch-json'

type ProviderType = 'oauth' | 'api_key' | 'custom'

interface Provider {
  id: string
  name: string
  type: ProviderType
  model: string
  isActive: boolean
  account: string | null
  baseUrl: string | null
  apiKey: string
}

interface FormData {
  name: string
  type: ProviderType
  apiKey: string
  baseUrl: string
  model: string
}

const INITIAL_FORM: FormData = {
  name: '',
  type: 'api_key',
  apiKey: '',
  baseUrl: '',
  model: 'sonnet',
}

export default function AiAssistantSettings() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormData>({ ...INITIAL_FORM })
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)

  // OAuth two-step state
  const [oauthUrl, setOauthUrl] = useState<string | null>(null)
  const [oauthCode, setOauthCode] = useState('')
  const [oauthBusy, setOauthBusy] = useState(false)
  const [oauthError, setOauthError] = useState<string | null>(null)

  // Test state
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const prov = await getJSON<{ providers: Provider[] }>(
        '/ai-assistant/providers'
      )
      setProviders(prov.providers || [])
    } catch {}
  }, [])

  useEffect(() => {
    load()
  }, [load, tick])

  const activate = async (id: string) => {
    try {
      await postJSON(`/ai-assistant/providers/${id}/activate`)
      setTick(n => n + 1)
    } catch {}
  }

  const remove = async (id: string) => {
    if (!window.confirm('Delete this provider?')) return
    try {
      await fetch(`/ai-assistant/providers/${id}`, { method: 'DELETE' })
      setTick(n => n + 1)
    } catch {}
  }

  const startOAuth = useCallback(async () => {
    setOauthBusy(true)
    setOauthError(null)
    try {
      const r = await postJSON<{ authorizeUrl: string }>(
        '/ai-assistant/oauth/start'
      )
      setOauthUrl(r.authorizeUrl)
      window.open(r.authorizeUrl, '_blank', 'noopener')
    } catch (e: any) {
      setOauthError(e?.message || String(e))
    } finally {
      setOauthBusy(false)
    }
  }, [])

  const handleOAuthSubmit = useCallback(
    async (ev: FormEvent) => {
      ev.preventDefault()
      setOauthBusy(true)
      setOauthError(null)
      try {
        await postJSON('/ai-assistant/oauth/exchange', {
          body: { code: oauthCode },
        })
        const name = form.name.trim() || 'Anthropic OAuth'
        const { id } = await postJSON<{ id: string }>(
          '/ai-assistant/providers',
          {
            body: { name, type: 'oauth', model: form.model },
          }
        )
        await activate(id)
        setShowForm(false)
        setForm({ ...INITIAL_FORM })
        setOauthUrl(null)
        setOauthCode('')
        setTick(n => n + 1)
      } catch (e: any) {
        setOauthError(e?.message || String(e))
      } finally {
        setOauthBusy(false)
      }
    },
    [oauthCode, form.name, form.model]
  )

  const testConnection = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await postJSON<{ ok: boolean; message: string }>(
        '/ai-assistant/providers/test',
        {
          body: {
            type: form.type,
            apiKey: form.apiKey,
            baseUrl: form.type === 'custom' ? form.baseUrl : undefined,
          },
        }
      )
      setTestResult(r.ok ? 'Connection OK' : r.message || 'Test failed')
    } catch (e: any) {
      setTestResult(e?.message || 'Test failed')
    } finally {
      setTesting(false)
    }
  }

  const submit = async () => {
    if (!form.name.trim()) return
    if (form.type === 'oauth') return // handled via startOAuth
    setLoading(true)
    try {
      if (editingId) {
        const body: Record<string, string> = {
          name: form.name,
          model: form.model,
        }
        if (form.apiKey) body.apiKey = form.apiKey
        if (form.type === 'custom' && form.baseUrl)
          body.baseUrl = form.baseUrl
        await fetch(`/ai-assistant/providers/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        const body: Record<string, string> = {
          name: form.name,
          type: form.type,
          model: form.model,
          apiKey: form.apiKey,
        }
        if (form.type === 'custom' && form.baseUrl)
          body.baseUrl = form.baseUrl
        await postJSON('/ai-assistant/providers', { body })
      }
      setShowForm(false)
      setEditingId(null)
      setForm({ ...INITIAL_FORM })
      setTestResult(null)
      setTick(n => n + 1)
    } catch (err: any) {
      alert(err?.message || 'Failed')
    } finally {
      setLoading(false)
    }
  }

  const startEdit = (p: Provider) => {
    setEditingId(p.id)
    setForm({
      name: p.name,
      type: p.type,
      apiKey: '',
      baseUrl: p.baseUrl || '',
      model: p.model,
    })
    setOauthUrl(null)
    setOauthCode('')
    setOauthError(null)
    setTestResult(null)
    setShowForm(true)
  }

  const cancelForm = () => {
    setShowForm(false)
    setEditingId(null)
    setForm({ ...INITIAL_FORM })
    setOauthUrl(null)
    setOauthCode('')
    setOauthError(null)
    setTestResult(null)
  }

  return (
    <div className="cc-settings">
      <div className="cc-settings-title">AI Providers</div>

      <div className="cc-provider-list">
        {providers.map(p => (
          <div
            key={p.id}
            className={
              'cc-provider-card' +
              (p.isActive ? ' cc-provider-card-active' : '')
            }
          >
            <div className="cc-provider-header">
              <span className="cc-provider-name">{p.name}</span>
              {p.isActive && (
                <span className="cc-provider-badge">Active</span>
              )}
            </div>
            <div className="cc-provider-meta">
              {p.type === 'oauth' && p.account
                ? p.account
                : p.type === 'oauth'
                  ? 'Not connected'
                  : null}
              {p.type !== 'oauth' && (
                <>
                  {p.model}
                  {p.apiKey ? ` · ${p.apiKey}` : ''}
                  {p.baseUrl ? ` · ${p.baseUrl}` : ''}
                </>
              )}
            </div>
            <div className="cc-provider-actions">
              {!p.isActive && (
                <button
                  className="cc-btn cc-btn-primary"
                  onClick={() => activate(p.id)}
                >
                  Activate
                </button>
              )}
              <button className="cc-btn" onClick={() => startEdit(p)}>
                Edit
              </button>
              <button
                className="cc-btn cc-btn-danger"
                onClick={() => remove(p.id)}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {!showForm && (
        <button
          className="cc-add-provider"
          onClick={() => {
            setEditingId(null)
            setForm({ ...INITIAL_FORM })
            setOauthUrl(null)
            setOauthCode('')
            setOauthError(null)
            setTestResult(null)
            setShowForm(true)
          }}
        >
          + Add Provider
        </button>
      )}

      {showForm && (
        <div className="cc-provider-form">
          <div className="cc-field">
            <label>Type</label>
            <select
              value={form.type}
              onChange={e =>
                setForm({ ...form, type: e.target.value as ProviderType })
              }
              disabled={!!editingId}
            >
              <option value="api_key">API Key (Anthropic)</option>
              <option value="custom">Custom Provider</option>
              {!editingId && (
                <option value="oauth">OAuth (Claude Account)</option>
              )}
            </select>
          </div>

          <div className="cc-field">
            <label>Name</label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="My Provider"
            />
          </div>

          {form.type === 'oauth' && (
            <div className="cc-oauth-section">
              {!oauthUrl ? (
                <button
                  type="button"
                  className="cc-btn cc-btn-primary"
                  onClick={startOAuth}
                  disabled={oauthBusy}
                >
                  {oauthBusy ? 'Connecting…' : 'Connect Claude'}
                </button>
              ) : (
                <form onSubmit={handleOAuthSubmit} className="cc-oauth-form">
                  <p className="cc-oauth-hint">
                    After authorizing, paste the code Anthropic displays here.
                  </p>
                  <input
                    type="text"
                    className="cc-input"
                    placeholder="Paste authorization code"
                    value={oauthCode}
                    onChange={e => setOauthCode(e.target.value)}
                    autoFocus
                  />
                  <div className="cc-row-gap">
                    <button
                      type="submit"
                      className="cc-btn cc-btn-primary"
                      disabled={oauthBusy || !oauthCode.trim()}
                    >
                      {oauthBusy ? '…' : 'Submit code'}
                    </button>
                    <button
                      type="button"
                      className="cc-btn cc-btn-ghost"
                      onClick={() =>
                        oauthUrl &&
                        window.open(oauthUrl, '_blank', 'noopener')
                      }
                    >
                      Reopen page
                    </button>
                  </div>
                </form>
              )}
              {oauthError && (
                <div className="cc-error">{oauthError}</div>
              )}
            </div>
          )}

          {(form.type === 'api_key' || form.type === 'custom') && (
            <>
              <div className="cc-field">
                <label>API Key</label>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={e =>
                    setForm({ ...form, apiKey: e.target.value })
                  }
                  placeholder="sk-ant-api03-..."
                />
              </div>

              <button
                type="button"
                className="cc-btn cc-btn-test"
                onClick={testConnection}
                disabled={testing || !form.apiKey}
              >
                {testing ? 'Testing…' : 'Test Connection'}
              </button>
              {testResult && (
                <div
                  className={
                    testResult === 'Connection OK'
                      ? 'cc-test-ok'
                      : 'cc-test-fail'
                  }
                >
                  {testResult}
                </div>
              )}
            </>
          )}

          {form.type === 'custom' && (
            <div className="cc-field">
              <label>Base URL</label>
              <input
                type="text"
                value={form.baseUrl}
                onChange={e =>
                  setForm({ ...form, baseUrl: e.target.value })
                }
                placeholder="https://api.example.com"
              />
            </div>
          )}

          <div className="cc-field">
            <label>Model</label>
            <select
              value={form.model}
              onChange={e => setForm({ ...form, model: e.target.value })}
            >
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
              <option value="haiku">Haiku</option>
            </select>
          </div>

          {form.type !== 'oauth' && (
            <div className="cc-form-actions">
              <button
                className="cc-btn cc-btn-primary"
                onClick={submit}
                disabled={loading}
              >
                {editingId ? 'Save' : 'Add'}
              </button>
              <button className="cc-btn" onClick={cancelForm}>
                Cancel
              </button>
            </div>
          )}
          {form.type === 'oauth' && (
            <div className="cc-form-actions" style={{ marginTop: 0 }}>
              <button className="cc-btn" onClick={cancelForm}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
