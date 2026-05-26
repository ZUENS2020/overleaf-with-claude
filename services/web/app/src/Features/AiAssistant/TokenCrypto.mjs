// JWE wrapper for storing Claude OAuth tokens at rest. Uses the same
// A256GCM/A256GCMKW pair as DeviceHistory so we don't introduce a new
// crypto primitive.

import crypto from 'node:crypto'
import * as jose from 'jose'
import Settings from '@overleaf/settings'

const ALG = { alg: 'A256GCMKW', enc: 'A256GCM' }
const DECRYPT_OPTS = {
  contentEncryptionAlgorithms: ['A256GCM'],
  keyManagementAlgorithms: ['A256GCMKW'],
}

let SECRET
function getSecret() {
  if (!SECRET) {
    const hex = Settings.aiAssistant?.tokenKey
    if (!hex) throw new Error('aiAssistant.tokenKey not configured')
    SECRET = crypto.createSecretKey(Buffer.from(hex, 'hex'))
  }
  return SECRET
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export async function seal(payload) {
  return await new jose.CompactEncrypt(enc.encode(JSON.stringify(payload)))
    .setProtectedHeader(ALG)
    .encrypt(getSecret())
}

export async function open(blob) {
  const { plaintext } = await jose.compactDecrypt(
    blob,
    getSecret(),
    DECRYPT_OPTS
  )
  return JSON.parse(dec.decode(plaintext))
}
