// Watches the session's working dir for file changes Claude makes and
// pushes them into Overleaf's docstore via DocumentUpdater so CodeMirror
// receives the edit in real time. Uses fs.watch (recursive) to avoid
// adding chokidar as a dep.
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

async function findDocIdByPath(projectId, relPath) {
  const docs = await ProjectEntityHandler.promises.getAllDocs(projectId)
  // getAllDocs returns paths starting with '/'; normalize both ways.
  const want = '/' + relPath.replace(/^\/+/, '')
  return docs[want]?._id?.toString() || null
}

export default {
  async start({ userId, projectId, cwd, onFileChanged }) {
    const pending = new Map() // relPath -> timer
    const lastWritten = new Map() // relPath -> contents we just pushed

    async function flush(relPath) {
      pending.delete(relPath)
      const full = join(cwd, relPath)
      try {
        const st = await stat(full)
        if (!st.isFile()) return
        const buf = await readFile(full, 'utf8')
        if (lastWritten.get(relPath) === buf) return
        lastWritten.set(relPath, buf)
        const docId = await findDocIdByPath(projectId, relPath)
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
    }
  },
}
