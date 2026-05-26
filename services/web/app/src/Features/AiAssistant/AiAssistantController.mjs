// HTTP surface for the AI assistant: OAuth begin/exchange/status/disconnect,
// session start/stop, message POST, and the SSE stream the chat UI reads.

import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import SessionManager from '../Authentication/SessionManager.mjs'
import * as ClaudeAuth from './ClaudeAuth.mjs'
import * as TokenStore from './TokenStore.mjs'
import AiAssistantManager from './AiAssistantManager.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import SessionStore from './SessionStore.mjs'

function enabled() {
  return !!Settings.aiAssistant?.claudeBin
}

function requireUser(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    res.status(401).json({ error: 'not_logged_in' })
    return null
  }
  return userId
}

export default {
  async oauthStart(req, res) {
    if (!enabled()) return res.status(503).json({ error: 'disabled' })
    const userId = requireUser(req, res)
    if (!userId) return
    try {
      const url = await ClaudeAuth.startLogin(userId)
      res.json({ authorizeUrl: url })
    } catch (err) {
      logger.warn({ err, userId }, 'claude auth login start failed')
      res.status(500).json({ error: 'start_failed', detail: err.message })
    }
  },

  async oauthExchange(req, res) {
    if (!enabled()) return res.status(503).json({ error: 'disabled' })
    const userId = requireUser(req, res)
    if (!userId) return
    const { code } = req.body || {}
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'missing_code' })
    }
    try {
      const tokens = await ClaudeAuth.submitCode(userId, code)
      await TokenStore.store(userId, tokens)
      res.json({ ok: true, account: tokens.account || null })
    } catch (err) {
      logger.warn({ err, userId }, 'claude auth login submit failed')
      res.status(400).json({ error: 'exchange_failed', detail: err.message })
    }
  },

  async oauthStatus(req, res) {
    if (!enabled()) return res.json({ enabled: false })
    const userId = requireUser(req, res)
    if (!userId) return
    const tok = await TokenStore.load(userId)
    res.json({
      enabled: true,
      connected: !!tok,
      account: tok?.account || null,
    })
  },

  async oauthDisconnect(req, res) {
    if (!enabled()) return res.status(503).json({ error: 'disabled' })
    const userId = requireUser(req, res)
    if (!userId) return
    await AiAssistantManager.stop(userId, req.params.Project_id).catch(() => {})
    await TokenStore.clear(userId)
    res.json({ ok: true })
  },

  async sendMessage(req, res) {
    if (!enabled()) return res.status(503).json({ error: 'disabled' })
    const userId = requireUser(req, res)
    if (!userId) return
    const projectId = req.params.Project_id
    const text = req.body?.text
    const permissionMode = req.body?.permissionMode
    const images = req.body?.images
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'missing_text' })
    }
    try {
      await AiAssistantManager.send(userId, projectId, text, { permissionMode, images })
      res.json({ ok: true })
    } catch (err) {
      logger.warn({ err, userId, projectId }, 'ai-assistant send failed')
      res.status(500).json({ error: err.message })
    }
  },

  async permissionResponse(req, res) {
    if (!enabled()) return res.status(503).json({ error: 'disabled' })
    const userId = requireUser(req, res)
    if (!userId) return
    const projectId = req.params.Project_id
    const { id, allow } = req.body || {}
    if (!id || typeof allow !== 'boolean') {
      return res.status(400).json({ error: 'missing_id_or_allow' })
    }
    try {
      AiAssistantManager.respondPermission(userId, projectId, id, allow)
      res.json({ ok: true })
    } catch (err) {
      logger.warn({ err, userId, projectId }, 'ai-assistant permission response failed')
      res.status(500).json({ error: err.message })
    }
  },

  async revertFile(req, res) {
    if (!enabled()) return res.status(503).json({ error: 'disabled' })
    const userId = requireUser(req, res)
    if (!userId) return
    const projectId = req.params.Project_id
    const { path } = req.body || {}
    if (!path || typeof path !== 'string') {
      return res.status(400).json({ error: 'missing_path' })
    }
    try {
      const docs = await ProjectEntityHandler.promises.getAllDocs(projectId)
      const fullPath = '/' + path.replace(/^\/+/, '')
      const doc = docs[fullPath]
      if (!doc) {
        return res.status(404).json({ error: 'file_not_found' })
      }
      const lines = (doc.lines || []).join('\n')
      // Revert by re-setting the document content (which is the pre-edit
      // version from FileSync's lastWritten map).  For simplicity, we
      // just re-push the current docstore version; the frontend can
      // issue a revert after seeing a diff.
      await DocumentUpdaterHandler.promises.setDocument(
        projectId,
        doc._id.toString(),
        userId,
        doc.lines,
        'ai-assistant-revert'
      )
      res.json({ ok: true })
    } catch (err) {
      logger.warn({ err, userId, projectId, path }, 'ai-assistant revert file failed')
      res.status(500).json({ error: err.message })
    }
  },

  async stop(req, res) {
    const userId = requireUser(req, res)
    if (!userId) return
    await AiAssistantManager.stop(userId, req.params.Project_id).catch(() => {})
    res.json({ ok: true })
  },

  // Project file list for the @ mention picker. Returns just the paths;
  // the UI does its own client-side fuzzy filter.
  async files(req, res) {
    const userId = requireUser(req, res)
    if (!userId) return
    const projectId = req.params.Project_id
    try {
      const docs = await ProjectEntityHandler.promises.getAllDocs(projectId)
      const paths = Object.keys(docs)
        .map(p => p.replace(/^\//, ''))
        .sort()
      res.json({ paths })
    } catch (err) {
      logger.warn({ err, userId, projectId }, 'ai-assistant file list failed')
      res.status(500).json({ error: err.message })
    }
  },

  async createSession(req, res) {
    if (!enabled()) return res.status(503).json({ error: 'disabled' })
    const userId = requireUser(req, res)
    if (!userId) return
    const projectId = req.params.Project_id
    const { title } = req.body || {}
    try {
      const session = await SessionStore.create(userId, projectId, title)
      res.json({ id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt })
    } catch (err) {
      logger.warn({ err, userId, projectId }, 'ai-assistant create session failed')
      res.status(500).json({ error: err.message })
    }
  },

  async listSessions(req, res) {
    if (!enabled()) return res.status(503).json({ error: 'disabled' })
    const userId = requireUser(req, res)
    if (!userId) return
    const projectId = req.params.Project_id
    try {
      const sessions = await SessionStore.list(userId, projectId)
      res.json({ sessions })
    } catch (err) {
      logger.warn({ err, userId, projectId }, 'ai-assistant list sessions failed')
      res.status(500).json({ error: err.message })
    }
  },

  async renameSession(req, res) {
    if (!enabled()) return res.status(503).json({ error: 'disabled' })
    const userId = requireUser(req, res)
    if (!userId) return
    const sessionId = req.params.sessionId
    const { title } = req.body || {}
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'missing_title' })
    }
    try {
      await SessionStore.update(sessionId, userId, { title })
      res.json({ ok: true })
    } catch (err) {
      logger.warn({ err, userId, sessionId }, 'ai-assistant rename session failed')
      res.status(500).json({ error: err.message })
    }
  },

  async deleteSession(req, res) {
    if (!enabled()) return res.status(503).json({ error: 'disabled' })
    const userId = requireUser(req, res)
    if (!userId) return
    const sessionId = req.params.sessionId
    try {
      await SessionStore.remove(sessionId, userId)
      res.json({ ok: true })
    } catch (err) {
      logger.warn({ err, userId, sessionId }, 'ai-assistant delete session failed')
      res.status(500).json({ error: err.message })
    }
  },

  // SSE stream of session events to the chat UI. One long-lived response;
  // closes on client disconnect.
  async stream(req, res) {
    const userId = requireUser(req, res)
    if (!userId) return
    const projectId = req.params.Project_id
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('connection', 'keep-alive')
    res.flushHeaders?.()

    const send = (event, data) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)

    try {
      await AiAssistantManager.ensureStarted(userId, projectId, send)
    } catch (err) {
      send('error', { message: err.message })
      clearInterval(heartbeat)
      res.end()
      return
    }
    const unsubscribe = AiAssistantManager.subscribe(userId, projectId, send)
    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  },
}
