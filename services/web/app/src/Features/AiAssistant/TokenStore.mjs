// Per-user Claude OAuth token storage. Tokens are encrypted with the
// AI_ASSISTANT_TOKEN_KEY before hitting Mongo.

import { User } from '../../models/User.mjs'
import { seal, open } from './TokenCrypto.mjs'
import * as ClaudeOauth from './ClaudeOauthClient.mjs'
import logger from '@overleaf/logger'

const REFRESH_BUFFER_MS = 5 * 60 * 1000

export async function load(userId) {
  const user = await User.findById(userId, { aiAssistant: 1 }).exec()
  const blob = user?.aiAssistant?.claudeOauth
  if (!blob) return null
  try {
    return await open(blob)
  } catch (err) {
    logger.warn({ err, userId }, 'failed to decrypt claude oauth token')
    return null
  }
}

export async function store(userId, tokens) {
  const blob = await seal(tokens)
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        'aiAssistant.claudeOauth': blob,
        'aiAssistant.claudeAccount': tokens.account || null,
      },
    }
  ).exec()
}

export async function clear(userId) {
  await User.updateOne(
    { _id: userId },
    { $unset: { 'aiAssistant.claudeOauth': 1, 'aiAssistant.claudeAccount': 1 } }
  ).exec()
}

// Returns a fresh access token. Refreshes if the stored one is near
// expiry. Returns null when the user hasn't connected.
export async function ensureFresh(userId) {
  const tok = await load(userId)
  if (!tok) return null
  if (tok.expiresAt - Date.now() > REFRESH_BUFFER_MS) return tok
  try {
    const next = await ClaudeOauth.refresh({ refreshToken: tok.refreshToken })
    // refresh response usually omits account; preserve the original label.
    if (!next.account) next.account = tok.account
    await store(userId, next)
    return next
  } catch (err) {
    logger.warn({ err, userId }, 'claude oauth refresh failed; clearing token')
    await clear(userId)
    return null
  }
}
