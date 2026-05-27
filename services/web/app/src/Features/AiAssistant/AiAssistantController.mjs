// HTTP surface for the AI assistant: OAuth begin/exchange/status/disconnect,
// session start/stop, message POST, and the SSE stream the chat UI reads.

import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import SessionManager from '../Authentication/SessionManager.mjs'
import * as ClaudeAuth from './ClaudeAuth.mjs'
import * as TokenStore from './TokenStore.mjs'
import AiAssistantManager from './AiAssistantManager.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import SessionStore from './SessionStore.mjs'
import { User } from '../../models/User.mjs'
import AiAssistantSettingsController from './AiAssistantSettingsController.mjs'

const ALLOWED_MODELS = new Set(['sonnet', 'opus', 'haiku'])

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
    const projectId = req.params.Project_id
    await AiAssistantSettingsController.migrateLegacyOAuth(userId).catch(() => {})
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
      if (err.code === 'INVALID_ID') {
        return res.status(400).json({ error: err.message })
      }
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
      if (err.code === 'INVALID_ID') {
        return res.status(400).json({ error: err.message })
      }
      logger.warn({ err, userId, projectId }, 'ai-assistant list sessions failed')
      res.status(500).json({ error: err.message })
    }
  },

  async renameSession(req, res) {
    if (!enabled()) return res.status(503).json({ error: 'disabled' })
    const userId = requireUser(req, res)
    if (!userId) return
    const sessionId = req.params.sessionId
    const projectId = req.params.Project_id
    const { title } = req.body || {}
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'missing_title' })
    }
    try {
      const ok = await SessionStore.update(sessionId, userId, projectId, {
        title,
      })
      if (!ok) return res.status(404).json({ error: 'not_found' })
      res.json({ ok: true })
    } catch (err) {
      if (err.code === 'INVALID_ID') {
        return res.status(400).json({ error: err.message })
      }
      logger.warn({ err, userId, sessionId }, 'ai-assistant rename session failed')
      res.status(500).json({ error: err.message })
    }
  },

  async getSessionMessages(req, res) {
    if (!enabled()) return res.status(503).json({ error: 'disabled' })
    const userId = requireUser(req, res)
    if (!userId) return
    const sessionId = req.params.sessionId
    const projectId = req.params.Project_id
    try {
      const messages = await SessionStore.getMessages(
        sessionId,
        userId,
        projectId
      )
      if (messages == null) return res.status(404).json({ error: 'not_found' })
      res.json({ messages })
    } catch (err) {
      if (err.code === 'INVALID_ID') {
        return res.status(400).json({ error: err.message })
      }
      logger.warn({ err, userId, sessionId }, 'ai-assistant get messages failed')
      res.status(500).json({ error: err.message })
    }
  },

  async saveSessionMessages(req, res) {
    if (!enabled()) return res.status(503).json({ error: 'disabled' })
    const userId = requireUser(req, res)
    if (!userId) return
    const sessionId = req.params.sessionId
    const projectId = req.params.Project_id
    const { messages } = req.body || {}
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'missing_messages' })
    }
    try {
      const ok = await SessionStore.setMessages(
        sessionId,
        userId,
        projectId,
        messages
      )
      if (!ok) return res.status(404).json({ error: 'not_found' })
      res.json({ ok: true })
    } catch (err) {
      if (err.code === 'INVALID_ID') {
        return res.status(400).json({ error: err.message })
      }
      logger.warn({ err, userId, sessionId }, 'ai-assistant save messages failed')
      res.status(500).json({ error: err.message })
    }
  },

  async deleteSession(req, res) {
    if (!enabled()) return res.status(503).json({ error: 'disabled' })
    const userId = requireUser(req, res)
    if (!userId) return
    const sessionId = req.params.sessionId
    const projectId = req.params.Project_id
    try {
      const ok = await SessionStore.remove(sessionId, userId, projectId)
      if (!ok) return res.status(404).json({ error: 'not_found' })
      res.json({ ok: true })
    } catch (err) {
      if (err.code === 'INVALID_ID') {
        return res.status(400).json({ error: err.message })
      }
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
    res.setHeader('x-accel-buffering', 'no')
    res.flushHeaders?.()

    const send = (event, data) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)

    try {
      let model = 'sonnet'
      try {
        const user = await User.findById(userId, { 'aiAssistant.preferredModel': 1 }).exec()
        model = user?.aiAssistant?.preferredModel || 'sonnet'
      } catch {}
      await AiAssistantManager.ensureStarted(userId, projectId, send, { model })
    } catch (err) {
      const errorType = err.message === 'not_connected' ? 'not_connected' : 'internal_error'
      send('error', { message: err.message, type: errorType })
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
