// Watches the session's working dir for file changes Claude makes and
// pushes them into Overleaf's docstore via DocumentUpdater so CodeMirror
// receives the edit in real time. Uses fs.watch (recursive) to avoid
// adding chokidar as a dep.
//
// For each path we snapshot the docstore content the FIRST time Claude
// touches it during a session; that snapshot is what `getOriginal`
// returns, so the controller's revert endpoint can push the pre-AI
// content back instead of being a no-op.
//
// Scope of this MVP: text docs only (matching extensions defined
// below). Binary/asset uploads via filestore are a follow-up.

import { watch } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import logger from '@overleaf/logger'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'

const TEXT_EXT = /\.(tex|bib|cls|sty|md|txt|json|yaml|yml)$/i
const DEBOUNCE_MS = 400

async function getDocsByPath(projectId) {
  return await ProjectEntityHandler.promises.getAllDocs(projectId)
}

function lookupDoc(docs, relPath) {
  // getAllDocs returns paths starting with '/'; normalize both ways.
  return docs['/' + relPath.replace(/^\/+/, '')] || null
}

export default {
  async start({ userId, projectId, cwd, onFileChanged }) {
    const pending = new Map() // relPath -> timer
    const lastWritten = new Map() // relPath -> contents we just pushed
    const originals = new Map() // relPath -> pre-AI docstore content

    async function flush(relPath) {
      pending.delete(relPath)
      const full = join(cwd, relPath)
      try {
        const st = await stat(full)
        if (!st.isFile()) return
        const buf = await readFile(full, 'utf8')
        if (lastWritten.get(relPath) === buf) return

        const docs = await getDocsByPath(projectId)
        const doc = lookupDoc(docs, relPath)
        if (!doc) {
          logger.debug(
            { projectId, relPath },
            'ai-assistant: no doc for path; skipping (creation not supported yet)'
          )
          return
        }

        // Snapshot the pre-AI content the first time we touch this
        // path. Subsequent edits in the same session keep the original
        // snapshot so revert always rewinds to before Claude touched
        // the file in this session.
        if (!originals.has(relPath)) {
          originals.set(relPath, (doc.lines || []).join('\n'))
        }

        lastWritten.set(relPath, buf)
        const lines = buf.split('\n')
        await DocumentUpdaterHandler.promises.setDocument(
          projectId,
          doc._id.toString(),
          userId,
          lines,
          'ai-assistant'
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

    return {
      async stop() {
        try {
          watcher.close()
        } catch {}
        for (const t of pending.values()) clearTimeout(t)
        pending.clear()
      },
      // Pre-AI content captured on first edit, or null if Claude hasn't
      // touched this path during the current session.
      getOriginal(relPath) {
        return originals.get(relPath) || null
      },
      // Called after a successful revert so the NEXT Claude edit
      // re-snapshots the (now-reverted) baseline.
      clearOriginal(relPath) {
        originals.delete(relPath)
        lastWritten.delete(relPath)
      },
    }
  },
}
