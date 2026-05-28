// Bidirectional sync between the AI session's working dir and Overleaf's
// docstore. Two halves:
//
// Forward (claude -> overleaf): fs.watch picks up files Claude wrote,
//   debounces, then calls DocumentUpdaterHandler.setDocument so the edit
//   propagates through OT into every connected CodeMirror.
//
// Reverse (overleaf -> claude): an SSE subscription to
//   document-updater's /project/:id/applied-ops/stream observes edits
//   made by real users in the editor (or by other AI sessions on the
//   same project). For each affected doc we re-fetch the full content
//   and write it into the working dir so the next Claude tool call sees
//   fresh bytes.
//
// Loop prevention:
//   * Forward writes carry meta.source = 'ai-assistant'; the reverse
//     handler filters those out so we don't pull back our own edits.
//   * Before writing a reverse-sync file we set lastWritten[relPath] to
//     the new content; the watcher then fires schedule()->flush(), but
//     flush() compares against lastWritten and bails out early — no
//     forward push, no echo.
//
// Scope of this MVP: text docs only. Binary/asset files and doc
// creation/deletion are follow-ups.

import { watch } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import { fetchStream } from '@overleaf/fetch-utils'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'

const TEXT_EXT = /\.(tex|bib|cls|sty|md|txt|json|yaml|yml)$/i
const DEBOUNCE_MS = 400
const SSE_RECONNECT_MS = 5000
const OWN_SOURCE = 'ai-assistant'

export default {
  async start({ userId, projectId, cwd, onFileChanged }) {
    const pending = new Map() // relPath -> timer (forward)
    const reversePending = new Map() // docId -> timer (reverse)
    const lastWritten = new Map() // relPath -> content; shared loop guard
    const docIdToPath = new Map() // docId -> relPath cache

    async function refreshDocMap() {
      const docs = await ProjectEntityHandler.promises.getAllDocs(projectId)
      docIdToPath.clear()
      for (const [absPath, doc] of Object.entries(docs)) {
        const id = doc?._id?.toString()
        if (!id) continue
        docIdToPath.set(id, absPath.replace(/^\/+/, ''))
      }
    }

    // ---- forward: fs.watch -> setDocument ----------------------------

    async function flush(relPath) {
      pending.delete(relPath)
      const full = join(cwd, relPath)
      try {
        const st = await stat(full)
        if (!st.isFile()) return
        const buf = await readFile(full, 'utf8')
        if (lastWritten.get(relPath) === buf) return
        lastWritten.set(relPath, buf)
        let docId = null
        for (const [id, p] of docIdToPath) {
          if (p === relPath) {
            docId = id
            break
          }
        }
        if (!docId) {
          // Cache miss: project may have new docs since session start.
          await refreshDocMap().catch(() => {})
          for (const [id, p] of docIdToPath) {
            if (p === relPath) {
              docId = id
              break
            }
          }
        }
        if (!docId) {
          logger.debug(
            { projectId, relPath },
            'ai-assistant: no doc for path; skipping (creation not supported yet)'
          )
          return
        }
        const lines = buf.split('\n')
        await DocumentUpdaterHandler.promises.setDocument(
          projectId,
          docId,
          userId,
          lines,
          OWN_SOURCE
        )
        onFileChanged?.(relPath)
      } catch (err) {
        if (err.code === 'ENOENT') return
        logger.warn({ err, relPath }, 'ai-assistant file flush failed')
      }
    }

    function schedule(relPath) {
      if (!TEXT_EXT.test(relPath)) return
      if (relPath.startsWith('.claude/')) return // ignore our cred dir
      const t = pending.get(relPath)
      if (t) clearTimeout(t)
      pending.set(
        relPath,
        setTimeout(() => flush(relPath), DEBOUNCE_MS)
      )
    }

    const watcher = watch(cwd, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      const relPath = filename.replace(/\\/g, '/')
      schedule(relPath)
    })

    // ---- reverse: applied-ops SSE -> writeFile -----------------------

    await refreshDocMap().catch(err =>
      logger.warn({ err, projectId }, 'ai-assistant initial doc map load failed')
    )

    async function pullDocToFile(docId) {
      reversePending.delete(docId)
      let relPath = docIdToPath.get(docId)
      if (!relPath) {
        await refreshDocMap().catch(() => {})
        relPath = docIdToPath.get(docId)
        if (!relPath) return // doc doesn't belong to this project anymore
      }
      // Skip files we don't mirror in the forward direction either.
      if (!TEXT_EXT.test(relPath)) return
      try {
        const { lines } = await DocumentUpdaterHandler.promises.getDocument(
          projectId,
          docId,
          -1
        )
        if (!Array.isArray(lines)) return
        const content = lines.join('\n')
        if (lastWritten.get(relPath) === content) return
        // Set lastWritten *before* writing so the watch callback's
        // flush() will see equality and skip — otherwise we'd echo
        // the reverse edit straight back into setDocument.
        lastWritten.set(relPath, content)
        const full = join(cwd, relPath)
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, content, 'utf8')
        onFileChanged?.(relPath)
      } catch (err) {
        logger.warn(
          { err, projectId, docId, relPath },
          'ai-assistant reverse sync fetch/write failed'
        )
      }
    }

    function scheduleReverse(docId) {
      const t = reversePending.get(docId)
      if (t) clearTimeout(t)
      reversePending.set(
        docId,
        setTimeout(() => pullDocToFile(docId), DEBOUNCE_MS)
      )
    }

    function handleOpEvent(parsed) {
      if (!parsed || typeof parsed !== 'object') return
      if (parsed.type === 'ready') return
      if (parsed.error) return
      const docId = parsed.doc_id
      if (!docId) return
      // The interesting source tag lives on the inner op object. For
      // updates that flow through ShareJsUpdateManager._sendOp the
      // shape is { project_id, doc_id, op: { v, op:[...], meta } }.
      const source = parsed.op?.meta?.source
      if (source === OWN_SOURCE) return
      scheduleReverse(docId)
    }

    let stopped = false
    let activeAbort = null

    async function consumeStream(stream) {
      let buf = ''
      for await (const chunk of stream) {
        buf += chunk.toString('utf8')
        let sep
        // SSE events are separated by a blank line. We don't need to
        // handle CR variants because document-updater emits LF only.
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          if (!block || block.startsWith(':')) continue // comment / heartbeat
          const dataLines = []
          for (const line of block.split('\n')) {
            if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).replace(/^ /, ''))
            }
          }
          if (dataLines.length === 0) continue
          let parsed
          try {
            parsed = JSON.parse(dataLines.join('\n'))
          } catch {
            continue
          }
          handleOpEvent(parsed)
        }
      }
    }

    async function runReverseLoop() {
      const baseUrl = Settings.apis.documentupdater.url
      const url = `${baseUrl}/project/${projectId}/applied-ops/stream`
      while (!stopped) {
        activeAbort = new AbortController()
        try {
          const stream = await fetchStream(url, {
            signal: activeAbort.signal,
          })
          await consumeStream(stream)
        } catch (err) {
          if (stopped || err?.name === 'AbortError') return
          logger.warn(
            { err, projectId },
            'ai-assistant applied-ops stream errored; reconnecting'
          )
        }
        if (stopped) return
        await new Promise(r => setTimeout(r, SSE_RECONNECT_MS))
      }
    }

    // Fire and forget; lifecycle is bounded by stop().
    runReverseLoop().catch(err =>
      logger.warn(
        { err, projectId },
        'ai-assistant reverse loop exited unexpectedly'
      )
    )

    return {
      async stop() {
        stopped = true
        try {
          activeAbort?.abort()
        } catch {}
        try {
          watcher.close()
        } catch {}
        for (const t of pending.values()) clearTimeout(t)
        pending.clear()
        for (const t of reversePending.values()) clearTimeout(t)
        reversePending.clear()
      },
    }
  },
}
