// Claude Code OAuth (PKCE, manual-code variant). Public client_id taken
// from the Claude Code CLI's own flow; redirect_uri uses Anthropic's
// "show the code to the user" endpoint, the same fallback the CLI uses
// over SSH where it can't open a localhost callback. The user pastes
// the displayed code back into our UI.

import crypto from 'node:crypto'
import logger from '@overleaf/logger'

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
const SCOPES = 'org:create_api_key user:profile user:inference'

function base64url(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function newPkcePair() {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(
    crypto.createHash('sha256').update(verifier).digest()
  )
  const state = base64url(crypto.randomBytes(16))
  return { verifier, challenge, state }
}

export function authorizeUrl({ challenge, state }) {
  const u = new URL(AUTHORIZE_URL)
  u.searchParams.set('code', 'true')
  u.searchParams.set('client_id', CLIENT_ID)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('redirect_uri', REDIRECT_URI)
  u.searchParams.set('scope', SCOPES)
  u.searchParams.set('code_challenge', challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', state)
  return u.toString()
}

export async function exchangeCode({ code, verifier, state }) {
  // Anthropic shows codes in the form `<code>#<state>` for the manual
  // flow. Accept either form.
  let rawCode = code.trim()
  let rawState = state
  if (rawCode.includes('#')) {
    const [c, s] = rawCode.split('#', 2)
    rawCode = c
    rawState = s
  }
  const body = {
    grant_type: 'authorization_code',
    code: rawCode,
    state: rawState,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  }
  return await postToken(body)
}

export async function refresh({ refreshToken }) {
  return await postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  })
}

async function postToken(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    logger.warn(
      { status: res.status, body: text.slice(0, 200) },
      'claude oauth token exchange failed'
    )
    throw new Error(`oauth ${res.status}: ${text.slice(0, 200)}`)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error('oauth token response not JSON')
  }
  if (!data.access_token || !data.refresh_token) {
    throw new Error('oauth token response missing tokens')
  }
  const expiresInMs = (data.expires_in || 3600) * 1000
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + expiresInMs,
    scope: data.scope || SCOPES,
    account: data.account?.email_address || data.account?.uuid || null,
  }
}

// File format the claude CLI expects at ~/.claude/.credentials.json.
// Verified against the CLI source as of Claude Code 1.x.
export function toCredentialsFile(tok) {
  return {
    claudeAiOauth: {
      accessToken: tok.accessToken,
      refreshToken: tok.refreshToken,
      expiresAt: tok.expiresAt,
      scopes: (tok.scope || SCOPES).split(' '),
      subscriptionType: 'unknown',
    },
  }
}
