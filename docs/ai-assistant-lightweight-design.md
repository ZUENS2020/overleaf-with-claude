# AI Assistant — Lightweight Redesign

## Why this exists

The initial prototype embedded a per-user `code-server` (full VS Code) in
an iframe, proxied through `webpack-dev-server → web → AiSessionProxy → code-server`.
This was heavy and fragile:

- ~500 MB image per session, multi-second container startup, hundreds of MB
  resident per active user
- ~50 MB JS bundle for the VS Code workbench on first iframe load
- WebSocket extension-host protocol forced three HTTP/WS proxy chains;
  every layer had bugs (glob matching, keep-alive agent poisoning, query
  strings, function-context target resolution)
- Iframe + cross-origin + sandbox flags added a permanent UX tax

The current implementation (PRs #2–#9) replaced the iframe/code-server approach
with an **in-process Claude CLI subprocess**. What we actually need is a chat
surface for Claude and the ability for Claude to read/edit project files —
not a full IDE.

## Actual Architecture (as implemented)

```
┌────────────────────┐         ┌───────────────────────────────┐
│  Overleaf frontend │         │           web service         │
│                    │         │                               │
│  ChatPane (React)  │◀──SSE──┤  AiAssistantController        │
│  SessionList       │         │  AiAssistantManager            │
│  Permission popup  │         │  SessionStore (MongoDB)        │
│  Inline diffs      │         │    ↓ spawn / stream           │
│  @ / menus         │         │  claude (CLI subprocess)      │
└────────────────────┘         │    ↓ writes files             │
                               │  FileSync (fs.watch)           │
                               │    → DocumentUpdater           │
                               └───────────────────────────────┘
```

### Key Design Decisions

- **Subprocess runs inside the web container** (not per-user Docker) — OK for
  single-tenant CE, NOT for multi-tenant SaaS
- **cwd** = `/tmp/overleaf-ai-assistant/<userId>-<projectId>/` (includes both
  userId and projectId in the path to avoid collisions)
- **File watcher**: Node.js native `fs.watch` (recursive), NOT chokidar —
  avoids adding a dependency. Debounced at 400ms.
- **File sync direction**: One-way only (Claude → Overleaf). Inverse direction
  (Overleaf editor → CWD) is **not implemented**.
- **Sessions keyed by** `${userId}:${projectId}` (combined string), not
  `projectId` alone — this is critical for per-user isolation
- **SSE over EventSource** (not Socket.IO), with 15s keep-alive pings

### Components

**`AiAssistantManager`** (`services/web/app/src/Features/AiAssistant/AiAssistantManager.mjs`)
- One `Session` instance per `(userId, projectId)` pair
- `Session` class fields: `userId, projectId, subscribers, proc, cwd,
  lastActivity, starting, idleTimer, fileSync, history`
- Spawns `claude --print --input-format stream-json --output-format stream-json
  --permission-mode <mode> --model <model>`
- Idle timeout (default 10 min, configurable via `AI_ASSISTANT_IDLE_MS`) kills
  the subprocess
- On session start: hydrate `cwd` by copying project files via
  `ProjectEntityHandler.promises.getAllDocs()`, then writes OAuth credentials
  to `cwd/.claude/.credentials.json`
- Exported API: `ensureStarted`, `subscribe`, `send`, `respondPermission`,
  `stop`, `stopAllForUser`

**`FileSync`** (`services/web/app/src/Features/AiAssistant/FileSync.mjs`)
- Watches the session CWD via `fs.watch(cwd, { recursive: true })`
- Debounces file change events (400ms)
- Filters: only text extensions (`.tex|.bib|.cls|.sty|.md|.txt|.json|.yaml|.yml`),
  ignores `.claude/` paths
- On change: reads file, matches path to doc ID via `getAllDocs()`, calls
  `DocumentUpdaterHandler.promises.setDocument()` to push into Overleaf's
  real-time pipeline
- Skips unknown paths (new file creation not supported)
- Tracks `lastWritten` to avoid re-pushing its own writes

**`SessionStore`** (`services/web/app/src/Features/AiAssistant/SessionStore.mjs`)
- MongoDB collection `aiAssistantSessions`
- Document schema: `{ userId, projectId, title, createdAt, updatedAt, messages[] }`
- CRUD API: `create`, `list`, `update` (rename), `remove`, `findById`
- Message persistence: `setMessages` and `getMessages` with 200-msg cap
  (BSON 16MB safety limit)
- All mutations filter by BOTH `userId` and `projectId` for security

**SSE stream** (web's EventSource endpoint)
- Client → server: RESTful HTTP endpoints (see route table below)
- Server → client SSE events:
  - `assistant-message { text }` — streamed model output
  - `thinking { text }` — extended thinking blocks
  - `tool-use { id, name, input }` — tool invocation
  - `tool-result { id, output, isError }` — tool result
  - `todos { todos }` — TodoWrite checklist
  - `permission-request { id, tool, input, description }` — ask user to approve
  - `file-changed { path }` — UI shows "↪ edited path"
  - `file-diff { path, hunks }` — diff preview with revert option
  - `status { state }` — `'starting' | 'running' | 'stopped'`
  - `turn-end { usage?, cost? }` — assistant turn finished
  - `error { message }` — fatal error
- Heartbeat: `: ping\n\n` every 15 seconds

### Route Table

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| POST | `/ai-assistant/oauth/start` | login | Begin OAuth |
| POST | `/ai-assistant/oauth/exchange` | login | Submit OAuth code |
| GET | `/ai-assistant/oauth/status` | login | Check connection |
| POST | `/ai-assistant/oauth/disconnect` | login | Clear tokens + stop sessions |
| GET | `/ai-assistant/preferences` | login | Get preferred model |
| PUT | `/ai-assistant/preferences` | login | Update preferred model |
| GET | `/project/:Project_id/ai-assistant/stream` | write | SSE stream |
| POST | `/project/:Project_id/ai-assistant/message` | write | Send message |
| POST | `/project/:Project_id/ai-assistant/stop` | write | Kill subprocess |
| GET | `/project/:Project_id/ai-assistant/files` | write | File list for @ picker |
| POST | `/project/:Project_id/ai-assistant/permission-response` | write | Approve/deny tool |
| GET | `/project/:Project_id/ai-assistant/sessions` | write | List sessions |
| POST | `/project/:Project_id/ai-assistant/sessions` | write | Create session |
| POST | `/project/:Project_id/ai-assistant/sessions/:sessionId/rename` | write | Rename session |
| DELETE | `/project/:Project_id/ai-assistant/sessions/:sessionId` | write | Delete session |
| GET | `/project/:Project_id/ai-assistant/sessions/:sessionId/messages` | write | Get messages |
| PUT | `/project/:Project_id/ai-assistant/sessions/:sessionId/messages` | write | Save messages |

Note: route params use `Project_id` (snake_case, matches Overleaf convention).
There is **no** `/revert-file` endpoint — reverts are handled client-side
via the diff UI's "Revert" button which calls the message API.

### Frontend

`ai-assistant-pane.tsx` — React panel (no iframe).
- **PanelHeader**: Logo, connection status dot, ☰ conversation list, ＋ new
  conversation, ■ stop, ⎋ sign out
- **SessionList**: Full-height sidebar, grouped by time
- **Message list**: user / assistant / thinking / tool-use / permission-request /
  file-diff / todos / turn-divider
- **Composer**: mode selector (Plan / Bypass — 2 cards), textarea, @ file
  picker, / command palette, image attachments, send button
- **Permission popup**: inline card with Allow/Deny
- **File diff cards**: collapsible diff with Revert button
- **Markdown rendering**: `.cc-markdown` with rounded code blocks

`ai-assistant-settings.tsx` — Provider settings panel (⚙ tab) — code exists on disk but is **not wired into the UI or backend router yet**.
  Backend: `AiAssistantSettingsController.mjs` (225 lines, full CRUD) is not imported
  by any router. Frontend component is not imported by the main pane.

### Security Model

The subprocess runs inside the web container:
- Shares uid 1000 — acceptable for single-tenant CE, NOT for multi-tenant SaaS
- `cwd` is restricted to `/tmp/overleaf-ai-assistant/<userId>-<projectId>/`
- No `--allowed-tools` restriction beyond cwd
- Network egress allowed (Claude needs Anthropic API)
- Idle killer bounds wall-clock time
- Auth: per-user OAuth (delegated to `claude auth login --claudeai`):
  1. Spawn `claude auth login --claudeai` with per-user temp HOME
  2. Capture the PKCE authorize URL from CLI output; return to browser
  3. User completes auth in browser, gets code
  4. Code posted back; fed to CLI stdin; CLI writes `.claude/.credentials.json`
  5. Read the credentials file, encrypt with TokenCrypto (JWE A256GCM),
     store in `User.aiAssistant.claudeOauth` (MongoDB)
  6. On subprocess spawn: decrypt, write to `cwd/.claude/.credentials.json`,
     set `HOME=cwd` so Claude CLI picks it up
  7. Temp HOME deleted on exit
- Token refresh handled automatically by Claude CLI (it reads the existing
  credentials file and refreshes if expired)

### Implementation Status

#### Phase 1 — Complete
- [x] AiAssistantManager: CLI spawn, stream-json parsing, SSE fan-out
- [x] AiAssistantController: HTTP surface (OAuth, stream, message, stop, files)
- [x] AiAssistantRouter: route registration
- [x] ClaudeAuth: OAuth flow delegated to `claude auth login --claudeai`
- [x] TokenStore + TokenCrypto: JWE encryption for OAuth tokens
- [x] FileSync: `fs.watch` → DocumentUpdater one-way sync
- [x] React chat panel with message timeline, composer, SSE streaming
- [x] Mode selector (2-column grid: Plan / Bypass)
- [x] Markdown rendering with rounded code blocks, blockquotes, tables
- [x] Webpack production build for LAN access on port 8082

#### Phase 2 — Complete
- [x] Enhanced @ file picker with file-type icons and directory path
- [x] Enhanced / command palette with icons and descriptions
- [x] Image attachments (📎 button, thumbnail preview, base64 upload)
- [x] Permission request popup (Allow/Deny, tool name + input details)
- [x] Inline diff cards with Revert button (client-side revert, no dedicated endpoint)
- [x] Multi-session management (SessionList sidebar, CRUD API, MongoDB storage)
- [x] Session list with time grouping (Today/Yesterday/earlier)
- [x] Auto-generated session titles from first message (80 char truncation)
- [x] Message persistence (GET/PUT messages per session, capped at 200)
- [x] Model selection (Sonnet/Opus/Haiku per user, stored in preferences)
- [x] Multi-tenancy isolation (per-user credentials, sessions keyed by userId+projectId)

#### Not Wired — Backend Code Exists, Needs Integration
- [ ] Provider settings system (`AiAssistantSettingsController`) — code complete but not routed
- [ ] Provider settings frontend (`ai-assistant-settings.tsx`) — component exists but not imported

#### Phase 3 — Not started
- [ ] SSE reconnection with history replay
- [ ] i18n (replace hardcoded English strings with `t()` calls)
- [ ] Pin Claude CLI version in Dockerfile (currently `@latest`)
- [ ] New file creation support (FileSync create-file endpoint)
- [ ] Full diff rendering (currently shows simplified diff)
- [ ] Reverse sync (Overleaf → CWD mirror)
- [ ] Binary/asset file sync (images, PDFs via filestore)

## Non-goals

- Full IDE experience (use Overleaf's editor; power users can run claude
  locally against a cloned repo)
- Multi-pane terminals, debugging UI, extensions
- Multi-tenant SaaS isolation (would need per-user containers)
