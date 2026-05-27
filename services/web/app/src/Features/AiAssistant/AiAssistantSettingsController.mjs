import logger from '@overleaf/logger'
import SessionManager from '../Authentication/SessionManager.mjs'
import * as TokenStore from './TokenStore.mjs'
import * as TokenCrypto from './TokenCrypto.mjs'
import AiAssistantManager from './AiAssistantManager.mjs'
import { User } from '../../models/User.mjs'

function newId() {
  return Math.random().toString(36).slice(2, 12)
}

function requireUser(req, res) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (!userId) {
    res.status(401).json({ error: 'not_logged_in' })
    return null
  }
  return userId
}

async function findUser(userId) {
  return User.findById(userId, { aiAssistant: 1 }).exec()
}

function maskKey(key) {
  if (!key) return ''
  if (key.length <= 11) return key.slice(0, 4) + '****'
  return key.slice(0, 7) + '****' + key.slice(-4)
}

export default {
  async getConnection(req, res) {
    const userId = requireUser(req, res)
    if (!userId) return
    try {
      const user = await findUser(userId)
      const providers = user?.aiAssistant?.providers || []
      const active = providers.find(p => p.isActive)
      if (!active) {
        return res.json({ active: null })
      }
      res.json({
        active: {
          type: active.type,
          name: active.name,
          model: active.model,
          account: active.account || null,
        },
      })
    } catch (err) {
      logger.warn({ err, userId }, 'getConnection failed')
      res.status(500).json({ error: err.message })
    }
  },

  async listProviders(req, res) {
    const userId = requireUser(req, res)
    if (!userId) return
    try {
      const user = await findUser(userId)
      const providers = (user?.aiAssistant?.providers || []).map(p => ({
        id: p.id,
        name: p.name,
        type: p.type,
        model: p.model,
        isActive: p.isActive,
        account: p.account || null,
        baseUrl: p.baseUrl || null,
        apiKey: maskKey(p.apiKey),
      }))
      res.json({ providers })
    } catch (err) {
      logger.warn({ err, userId }, 'listProviders failed')
      res.status(500).json({ error: err.message })
    }
  },

  async createProvider(req, res) {
    const userId = requireUser(req, res)
    if (!userId) return
    try {
      const { name, type, apiKey, baseUrl, model } = req.body || {}
      if (!name || !type || !['oauth', 'api_key', 'custom'].includes(type)) {
        return res.status(400).json({ error: 'missing_name_or_invalid_type' })
      }
      if ((type === 'api_key' || type === 'custom') && !apiKey) {
        return res.status(400).json({ error: 'api_key_required' })
      }
      if (type === 'custom' && !baseUrl) {
        return res.status(400).json({ error: 'base_url_required_for_custom' })
      }

      const provider = {
        id: newId(),
        name,
        type,
        apiKey: type !== 'oauth' ? await TokenCrypto.seal(apiKey.trim()) : '',
        baseUrl: type === 'custom' ? baseUrl.trim() : '',
        model: model || 'sonnet',
        isActive: false,
        account: '',
      }

      await User.updateOne(
        { _id: userId },
        { $push: { 'aiAssistant.providers': provider } }
      ).exec()

      res.json({ id: provider.id })
    } catch (err) {
      logger.warn({ err, userId }, 'createProvider failed')
      res.status(500).json({ error: err.message })
    }
  },

  async updateProvider(req, res) {
    const userId = requireUser(req, res)
    if (!userId) return
    try {
      const { id } = req.params
      const user = await findUser(userId)
      const providers = user?.aiAssistant?.providers || []
      const idx = providers.findIndex(p => p.id === id)
      if (idx === -1) return res.status(404).json({ error: 'not_found' })

      const { name, apiKey, baseUrl, model } = req.body || {}
      const setFields = {}
      if (name !== undefined) setFields[`aiAssistant.providers.${idx}.name`] = name
      if (apiKey !== undefined) {
        setFields[`aiAssistant.providers.${idx}.apiKey`] = await TokenCrypto.seal(apiKey.trim())
      }
      if (baseUrl !== undefined) setFields[`aiAssistant.providers.${idx}.baseUrl`] = baseUrl.trim()
      if (model !== undefined) setFields[`aiAssistant.providers.${idx}.model`] = model

      if (Object.keys(setFields).length > 0) {
        await User.updateOne({ _id: userId }, { $set: setFields }).exec()
      }
      res.json({ ok: true })
    } catch (err) {
      logger.warn({ err, userId }, 'updateProvider failed')
      res.status(500).json({ error: err.message })
    }
  },

  async deleteProvider(req, res) {
    const userId = requireUser(req, res)
    if (!userId) return
    try {
      const { id } = req.params
      const user = await findUser(userId)
      const providers = user?.aiAssistant?.providers || []
      const provider = providers.find(p => p.id === id)
      if (!provider) return res.status(404).json({ error: 'not_found' })

      if (provider.isActive) {
        await AiAssistantManager.stopAllForUser(userId)
      }

      await User.updateOne(
        { _id: userId },
        { $pull: { 'aiAssistant.providers': { id } } }
      ).exec()

      res.json({ ok: true })
    } catch (err) {
      logger.warn({ err, userId }, 'deleteProvider failed')
      res.status(500).json({ error: err.message })
    }
  },

  async activateProvider(req, res) {
    const userId = requireUser(req, res)
    if (!userId) return
    try {
      const { id } = req.params
      const user = await findUser(userId)
      const providers = user?.aiAssistant?.providers || []
      const target = providers.find(p => p.id === id)
      if (!target) return res.status(404).json({ error: 'not_found' })

      await AiAssistantManager.stopAllForUser(userId)

      const bulkOps = providers.map((p, i) => ({
        updateOne: {
          filter: { _id: userId },
          update: { $set: { [`aiAssistant.providers.${i}.isActive`]: p.id === id } },
        },
      }))
      await User.bulkWrite(bulkOps)

      res.json({ ok: true, name: target.name, type: target.type, model: target.model })
    } catch (err) {
      logger.warn({ err, userId }, 'activateProvider failed')
      res.status(500).json({ error: err.message })
    }
  },

  async migrateLegacyOAuth(userId) {
    try {
      const user = await findUser(userId)
      const oauth = user?.aiAssistant?.claudeOauth
      if (!oauth) return
      const has = (user.aiAssistant.providers || []).some(p => p.type === 'oauth')
      if (has) return
      const account = user.aiAssistant.claudeAccount || ''

      const provider = {
        id: 'oauth-legacy-' + String(userId),
        name: 'Anthropic OAuth',
        type: 'oauth',
        apiKey: '',
        baseUrl: '',
        model: user.aiAssistant.preferredModel || 'sonnet',
        isActive: true,
        account,
      }
      await User.updateOne(
        { _id: userId },
        { $push: { 'aiAssistant.providers': provider } }
      ).exec()
    } catch (err) {
      logger.warn({ err, userId }, 'migrateLegacyOAuth failed')
    }
  },

  async testProvider(req, res) {
    const userId = requireUser(req, res)
    if (!userId) return
    try {
      const { type, apiKey, baseUrl } = req.body || {}
      if (!apiKey) return res.status(400).json({ error: 'api_key_required' })

      const targetUrl = (baseUrl || 'https://api.anthropic.com').replace(
        /\/+$/,
        ''
      )
      const resp = await fetch(`${targetUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: AbortSignal.timeout(10000),
      })

      if (resp.ok) {
        res.json({ ok: true, message: 'Connection OK' })
      } else if (resp.status === 401 || resp.status === 403) {
        res.json({
          ok: false,
          message: 'Invalid API key (401/403)',
        })
      } else {
        const body = await resp.text().catch(() => '')
        res.json({
          ok: false,
          message: `HTTP ${resp.status}: ${body.slice(0, 100)}`,
        })
      }
    } catch (err) {
      logger.warn({ err, userId }, 'testProvider failed')
      res.json({
        ok: false,
        message: err.cause?.code || err.message || 'Connection failed',
      })
    }
  },
}
