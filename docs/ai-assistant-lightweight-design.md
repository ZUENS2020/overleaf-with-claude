# AI Assistant — Lightweight Redesign

## Why this exists

The current implementation embeds a per-user `code-server` (full VS Code) in
an iframe, proxied through `webpack-dev-server → web → AiSessionProxy → code-server`.
This is heavy and fragile:

- ~500 MB image per session, multi-second container startup, hundreds of MB
  resident per active user
- ~50 MB JS bundle for the VS Code workbench on first iframe load
- WebSocket extension-host protocol forced us to chain three HTTP/WS proxies;
  every layer has had a bug (glob matching, keep-alive agent poisoning, query
  strings, function-context target resolution, etc.)
- Iframe + cross-origin + sandbox flags add a permanent UX tax

We don't actually need an IDE. The user is already in Overleaf's CodeMirror.
What we need is a chat surface for Claude and the ability for Claude to read/
edit project files.

## Target architecture

```
┌────────────────────┐         ┌───────────────────────────────┐
│  Overleaf frontend │         │           web service         │
│                    │         │                               │
│  ChatPane (React)  │◀──SSE──┤  AiAssistantController        │
│  SessionList       │         │  AiAssistantManager            │
│  Permission popup  │         │  SessionStore (MongoDB)        │
│  Inline diffs      │         │    ↓ spawn / stream           │
│  @ / menus         │         │  claude (CLI subprocess)      │
└────────────────────┘         │    cwd = /tmp/ai/<projectId>/ │
                               │    tools: Read/Edit/Bash...   │
                               │    ↓ writes files             │
                               │  FileSync                     │
                               │    ↓ DocumentUpdater + filestore
                               └───────────────────────────────┘
                                               │
                                               ▼
                                        Overleaf docstore
                                        (live updates to CodeMirror
                                         via existing real-time pipeline)
```

### Components

**`AiAssistantManager`** (services/web)
- One subprocess per `(userId, projectId)` pair
- Spawns `claude --output-format stream-json --input-format stream-json` with
  `cwd = /tmp/ai/<projectId>/`
- Maintains map: `projectId → { proc, stdin, lastActivity }`
- Idle timeout (default 10 min) kills the subprocess
- On session start: hydrate `cwd` by copying project files out of docstore via
  `ProjectEntityHandler`

**`SessionStore`** (services/web, MongoDB collection `aiAssistantSessions`)
- Stores session metadata: `userId, projectId, title, createdAt, updatedAt`
- CRUD API: create, list, rename, delete
- Used by frontend SessionList to switch between conversations
- Titles auto-generated from first message text

**`FileSync`**
- Watches the subprocess `cwd` via `chokidar`
- Text file change → `DocumentUpdater.setDocument` (existing internal API
  that real-time already uses; CodeMirror picks up the patch)
- Binary/asset change → `FileStoreHandler`
- Inverse direction (user edits in Overleaf → mirror to `cwd`) handled by
  subscribing to docstore updates for the project

**SSE stream** (web's EventSource endpoint, NOT socket.io)
- Client → server: HTTP POST endpoints
  - `POST /project/:id/ai-assistant/message` — send user message
  - `POST /project/:id/ai-assistant/stop` — kill subprocess
  - `POST /project/:id/ai-assistant/permission-response` — approve/deny tool
  - `POST /project/:id/ai-assistant/revert-file` — revert a file edit
  - `POST /project/:id/ai-assistant/sessions` — create new session
  - `POST /project/:id/ai-assistant/sessions/:id/rename` — rename session
  - `DELETE /project/:id/ai-assistant/sessions/:id` — delete session
  - `GET /project/:id/ai-assistant/sessions` — list sessions
- Server → client SSE events
  - `assistant-message { text }` — streamed model output
  - `thinking { text }` — extended thinking blocks
  - `tool-use { id, name, input }` — tool invocation
  - `tool-result { id, output, isError }` — tool result
  - `todos { todos }` — TodoWrite checklist
  - `permission-request { id, tool, input, description }` — ask user to approve
  - `file-changed { path }` — UI shows "↪ edited path"
  - `file-diff { path, hunks }` — diff preview with revert option
  - `status { state }` — 'starting' | 'running' | 'stopped'
  - `turn-end { usage?, cost? }` — assistant turn finished
  - `error { message }` — fatal error

### Frontend

`ai-assistant-pane.tsx` — a normal React panel (no iframe).
- **PanelHeader**: Logo, connection status dot, ☰ conversation list button, ＋ new conversation, ■ stop, ⎋ sign out
- **SessionList**: Full-height sidebar overlay showing conversation history, grouped by time (Today/Yesterday/earlier). Click to switch, hover to delete.
- **Message list**: user / assistant / thinking / tool-use / permission-request / file-diff / todos
- **Composer**: mode selector (Ask/Plan/Accept edits/Bypass), textarea, @ file picker, / command palette, image attachments, send button
- **Permission popup**: inline card showing tool name, input, description with Allow/Deny buttons
- **File diff cards**: collapsible diff with Revert button
- **Markdown rendering**: `.cc-markdown` with rounded code blocks, blockquotes, tables

### Security model

The subprocess runs *inside the web container* (not a per-user container).
That means:
- It shares the web container's user (uid 1000) — fine for our threat model
  (single-tenant CE deployment), but **not** for multi-tenant SaaS.
- `cwd` is restricted to `/tmp/ai/<projectId>/`. We do NOT pass `--allowed-tools`
  with anything outside that.
- Network egress: allow (claude needs to call Anthropic API).
- Resource limits: idle killer bounds wall-clock time.
- Auth: **per-user OAuth (Claude subscription), in-browser flow**. No
  API key, no shared host login.
  - Each Overleaf user connects their own Claude account from the AI
    Assistant pane: a "Connect Claude" button starts a PKCE OAuth flow
    against `https://platform.claude.com/oauth/authorize` using Claude Code's
    public client_id, with redirect to manual code exchange.
  - Tokens encrypted (JWE with `AI_ASSISTANT_TOKEN_KEY`) and stored per-user
    in MongoDB (`users.aiAssistant.claudeOauth`).
  - On subprocess spawn: write a temporary
    `/tmp/ai/<projectId>/.claude/credentials.json`, run with
    `HOME=/tmp/ai/<projectId>` so the CLI picks it up. Deleted on process exit.

### Session management

Sessions (conversations) are persisted in MongoDB (`aiAssistantSessions` collection):
- Each session has: `userId, projectId, title, createdAt, updatedAt`
- Creating a new conversation creates a session record and resets the chat
- First message text (truncated to 80 chars) becomes the session title
- Session list UI accessible via ☰ button in the panel header, grouped by time
- Switching sessions loads the new session and restarts the CLI subprocess
- Deleting a session removes it from the database

## Implementation status

### Phase 1 — Complete
- [x] AiAssistantManager: CLI spawn, stream-json parsing, SSE fan-out
- [x] AiAssistantController: HTTP surface (OAuth, stream, message, stop, files)
- [x] AiAssistantRouter: route registration
- [x] ClaudeAuth: OAuth flow via `claude auth login --claudeai`
- [x] TokenStore + TokenCrypto: JWE encryption for OAuth tokens
- [x] FileSync: chokidar → DocumentUpdater bidirectional sync
- [x] React chat panel with message timeline, composer, SSE streaming
- [x] Mode selector (4-column grid: Ask/Plan/Accept edits/Bypass)
- [x] Markdown rendering with rounded code blocks, blockquotes, tables
- [x] Webpack exposed on 0.0.0.0:8082 for LAN access

### Phase 2 — Complete
- [x] Enhanced @ file picker with file-type icons and directory path
- [x] Enhanced / command palette with icons and descriptions
- [x] Image attachments (📎 button, thumbnail preview, base64 upload)
- [x] Permission request popup (Allow/Deny, tool name + input details)
- [x] Inline diff cards with Revert button (`/revert-file` endpoint)
- [x] Multi-session management (SessionList sidebar, CRUD API, MongoDB storage)
- [x] Session list with time grouping (Today/Yesterday/earlier)
- [x] Auto-generated session titles from first message
- [x] ★ New conversation button creates backend session record

### Phase 3 — Not started
- [ ] SSE reconnection with history replay
- [ ] i18n (replace hardcoded English strings with `t()` calls)
- [ ] Pin Claude CLI version in Dockerfile
- [ ] New file creation support (FileSync create-file endpoint)
- [ ] Full diff rendering (currently shows placeholder text)

## Non-goals

- Full IDE experience (use Overleaf's editor; for power users, they can run
  claude locally against a cloned repo)
- Multi-pane terminals, debugging UI, extensions