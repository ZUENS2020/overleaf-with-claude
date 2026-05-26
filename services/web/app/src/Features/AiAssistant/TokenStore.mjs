// Per-user Claude OAuth token storage. Tokens are encrypted with the
// AI_ASSISTANT_TOKEN_KEY before hitting Mongo. The claude CLI itself
// handles access-token refresh when spawned with a credentials file
// containing a valid refresh token, so we don't run a refresh loop here
// — we just store what the CLI wrote and let it manage rotation.

import { User } from '../../models/User.mjs'
import { seal, open } from './TokenCrypto.mjs'
import logger from '@overleaf/logger'

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

// Kept for API compatibility with the manager — returns the stored
// token blob as-is.
export async function ensureFresh(userId) {
  return await load(userId)
}
