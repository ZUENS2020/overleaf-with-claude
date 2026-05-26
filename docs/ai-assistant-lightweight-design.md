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
│  ChatPane (React)  │◀────────┤  socket.io  ai-assistant ns   │
│  CodeMirror diff   │         │  ──────────────────────────   │
│  preview           │         │  AiAssistantManager           │
└────────────────────┘         │    ↓ spawn / stream           │
                               │  claude (CLI subprocess)      │
                               │    cwd = /tmp/ai/<projectId>/ │
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
- Spawns `claude --output-format stream-json --input-format stream-json` (or
  Agent SDK if simpler) with `cwd = /tmp/ai/<projectId>/`
- Maintains map: `projectId → { proc, stdin, lastActivity }`
- Idle timeout (default 10 min) kills the subprocess
- On session start: hydrate `cwd` by copying project files out of docstore via
  `ProjectEntityHandler`

**`FileSync`**
- Watches the subprocess `cwd` via `chokidar`
- Text file change → `DocumentUpdater.setDocument` (existing internal API
  that real-time already uses; CodeMirror picks up the patch)
- Binary/asset change → `FileStoreHandler`
- Inverse direction (user edits in Overleaf → mirror to `cwd`) handled by
  subscribing to docstore updates for the project

**Socket.io `ai-assistant` namespace** (web's socket.io, NOT real-time —
keeps auth in one place)
- Client → server events
  - `start { projectId }` — boot subprocess if not running
  - `prompt { text }` — write to subprocess stdin
  - `stop` — kill subprocess
- Server → client events
  - `assistant-text { delta }` — streamed model output
  - `tool-use { name, input }` — surfaced for UI
  - `tool-result { name, output }`
  - `file-changed { path }` — UI can show "Claude edited foo.tex"
  - `status { state: 'idle'|'running'|'error', error? }`

### Frontend

`ai-assistant-pane.tsx` becomes a normal React panel — no iframe.
- Message list (user / assistant / tool-use blocks)
- Composer input box
- Per-message inline diff preview using a `CodeMirror` instance in read-only
  mode, fed the before/after of edited files
- Stop button kills the subprocess

### Security model

The subprocess runs *inside the web container* (not a per-user container).
That means:
- It shares the web container's user (uid 1000) — fine for our threat model
  (single-tenant CE deployment), but **not** for multi-tenant SaaS. Adding
  per-user bubblewrap/nsjail is a follow-up if needed.
- `cwd` is restricted to `/tmp/ai/<projectId>/`. We do NOT pass `--allowed-tools`
  with anything outside that.
- Network egress: by default, allow (claude needs to call Anthropic API). If
  we want to block other egress, wrap in a network namespace later.
- Resource limits: `setrlimit` on RSS and CPU time when spawning. Idle killer
  bounds wall-clock.
- Auth: **per-user OAuth (Claude subscription), in-browser flow**. No
  API key, no shared host login.
  - Each Overleaf user connects their own Claude account from the AI
    Assistant pane: a "Connect Claude" button starts a PKCE OAuth flow
    against `https://claude.ai/oauth/authorize` using Claude Code's
    public client_id, with `redirect_uri=https://console.anthropic.com/oauth/code/callback`
    (the same "manual code paste" branch the CLI uses over SSH).
  - User authorizes on anthropic.com, copies the displayed code back into
    Overleaf, backend exchanges code + PKCE verifier for `access_token`
    and `refresh_token`.
  - Tokens are encrypted (libsodium secretbox, key from
    `AI_ASSISTANT_TOKEN_KEY` env) and stored per-user in Mongo
    (`users.aiAssistant.claudeOauth = { accessToken, refreshToken,
    expiresAt, scope }`).
  - On subprocess spawn: write a temporary per-session
    `/tmp/ai/<projectId>/.claude/credentials.json` matching the format
    the CLI expects, run with `HOME=/tmp/ai/<projectId>` so the CLI
    picks it up. File deleted on process exit.
  - `ANTHROPIC_API_KEY` is explicitly unset in subprocess env — if it
    leaks the CLI prefers it over OAuth.
  - Refresh: a small `ClaudeOauthClient` module refreshes access tokens
    before spawning if they have <5 min left; writes the new pair back
    to Mongo.

### Migration

1. Land new stack behind a feature flag (`AI_ASSISTANT_MODE=lightweight|legacy`,
   default `lightweight`).
2. Once verified, delete `AiSessionProxy.mjs`, `AiSessionManager.mjs`,
   `services/claude-ide-container/`, the `claude-ide` compose service, the
   webpack `setupMiddlewares` / `onListening` hacks, and the dockerode
   dependency from `services/web/package.json`.
3. Drop `/ai/session/*` routes and the iframe.

## Non-goals

- Full IDE experience (use Overleaf's editor; for power users, they can run
  claude locally against a cloned repo)
- Multi-pane terminals, debugging UI, extensions

## Open questions

- Do we want a thinking-aware UI (show extended-thinking blocks)?
  Recommendation: yes, collapsed by default.
- Streaming JSON parsing: parse `claude --output-format stream-json
  --input-format stream-json` directly via spawned CLI. We can't use the
  Agent SDK because it authenticates with ANTHROPIC_API_KEY only — we
  need the CLI's OAuth flow.
- Persisting conversation history across page reloads: store last N messages
  per `(userId, projectId)` in Redis with 24 h TTL.
