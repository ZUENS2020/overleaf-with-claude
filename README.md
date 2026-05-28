# Overleaf + Claude Code AI Assistant

An open-source online collaborative LaTeX editor with an integrated Claude Code AI assistant. Forked from [Overleaf Community Edition](https://github.com/overleaf/overleaf) (AGPL-3.0).

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#configuration-reference">Configuration</a> •
  <a href="#changes-from-upstream">Changes</a> •
  <a href="#license">License</a>
</p>

## Features

### Claude Code AI Assistant

- **Chat panel** — real-time SSE streaming conversation with Claude, side-by-side with your LaTeX project
- **OAuth login** — each user connects their own Claude account via browser-based authorization (PKCE flow delegated to `claude auth login --claudeai`)
- **Two permission modes** — **Plan** (read-only analysis) and **Bypass** (full-auto file edits and commands)
- **Model selection** — Sonnet, Opus, or Haiku per user, persisted in MongoDB
- **@ file picker** — mention project files with fuzzy-filter, file-type icons, directory paths
- **Image attachments** — paste or upload images into chat (base64, sent with message)
- **Multi-session management** — multiple conversations per project, auto-titled from first message, stored in MongoDB with message persistence
- **Multi-tenant isolation** — per-user Claude credentials, sessions (keyed by `${userId}:${projectId}`), and JWE-encrypted OAuth tokens; read-only collaborators see a block message
- **Provider system** — OAuth, API key, or custom relay URL as named profiles, one active at a time (backend code exists but not wired into router yet — currently using OAuth-only flow)

### Overleaf CE Base

All features of Overleaf Community Edition: real-time collaborative editing, PDF preview, Git integration, track changes, project history, and more.

## Authentication

Currently supports OAuth-only Claude login via in-browser PKCE authorization. The provider system (API key, custom relay URL) has backend code written but is not yet routed — see the [Provider Settings](#provider-settings) section below.

## Quick Start

### Prerequisites

- Docker + Docker Compose (v2)
- ~4 GB RAM (8 GB recommended for large LaTeX compiles)
- Linux server (x86-64); macOS works for local development

### Setup

```bash
git clone https://github.com/ZUENS2020/overleaf-with-claude
cd overleaf-with-claude
cp develop/dev.env.example develop/dev.env   # if it doesn't exist
# Generate a token key if not auto-created:
#   openssl rand -hex 32
```

Create and start services (production mode):

```bash
# Build frontend assets (required once, or after frontend changes)
docker compose -p overleaf-claude run --rm webpack npm run webpack:production

# Start all services
docker compose -p overleaf-claude up -d

# Wait for health checks, then create an admin user
docker exec -it overleaf-claude-web-1 node /overleaf/tools/cli create-admin
```

Open `http://your-server-ip:8082`, log in, open a project, and click the Claude icon in the right sidebar to connect your Claude account.

### Requirements for AI Assistant

The `claude` CLI is pre-installed in the web container image (`@anthropic-ai/claude-code`). Each user must:
1. Have an Anthropic account with Claude subscription
2. Open the AI Assistant panel in Overleaf
3. Click "Connect Claude" to start the OAuth flow
4. Follow the in-browser PKCE authorization

## Architecture

```
Browser                            Server (port 8082)
──────                              ──────
  Editor UI ─────POST──────────►  nginx (:8082 → web:3000)
  SSE stream ◄──GET /stream────   (no buffering, long-lived)
  WebSocket  ◄──/socket.io/────   nginx → real-time:3026
                                      │
  AiAssistantPane (React)              ├─ AiAssistantController
  AiAssistantManager (subprocess)      ├─ AiAssistantManager
  SessionStore (MongoDB)               ├─ FileSync
  FileSync (fs.watch → DocUpdater)     ├─ TokenStore + TokenCrypto
                                       ├─ SessionStore
                                       └─ AiAssistantSettingsController
```

- **Claude CLI** runs as an in-process subprocess via `spawn()`, one per `(userId, projectId)` pair
- Session working directory: `/tmp/overleaf-ai-assistant/<userId>-<projectId>/`
- **File sync**: Claude's file writes are detected via native `fs.watch` (recursive) and pushed into Overleaf's docstore via `DocumentUpdater.setDocument`. The sync is **one-directional** (Claude → Overleaf only) — user edits in the Overleaf editor are not mirrored back to the working directory.
- **OAuth tokens** encrypted with JWE (A256GCM/A256GCMKW) before storing in MongoDB User document
- Frontend assets compiled via webpack in production mode, served directly by the web service
- nginx proxies SSE streams without buffering (`proxy_buffering off`) with 1-hour read timeout; WebSocket upgrades to real-time service
- Idle sessions are killed after `AI_ASSISTANT_IDLE_MS` (default 10 min) of inactivity

### Component Overview

| Component | Module | Responsibility |
|-----------|--------|----------------|
| `AiAssistantManager` | `services/web/app/src/Features/AiAssistant/AiAssistantManager.mjs` | CLI spawn, stream-json parsing, SSE fan-out, idle timer, session lifecycle |
| `AiAssistantController` | `services/web/app/src/Features/AiAssistant/AiAssistantController.mjs` | HTTP handlers: OAuth, message, stop, session CRUD, SSE stream |
| `AiAssistantRouter` | `services/web/app/src/Features/AiAssistant/AiAssistantRouter.mjs` | Route registration (per-user + per-project) |
| `AiAssistantSettingsController` | `services/web/app/src/Features/AiAssistant/AiAssistantSettingsController.mjs` | Provider CRUD (OAuth/API key/custom relay) |
| `ClaudeAuth` | `services/web/app/src/Features/AiAssistant/ClaudeAuth.mjs` | Delegates to `claude auth login --claudeai`, captures OAuth URL, feeds code back |
| `TokenStore` | `services/web/app/src/Features/AiAssistant/TokenStore.mjs` | Encrypt/store/load OAuth tokens in `User.aiAssistant.claudeOauth` |
| `TokenCrypto` | `services/web/app/src/Features/AiAssistant/TokenCrypto.mjs` | JWE seal/open with `AI_ASSISTANT_TOKEN_KEY` |
| `FileSync` | `services/web/app/src/Features/AiAssistant/FileSync.mjs` | Watches CWD via `fs.watch` (not chokidar), debounces, pushes to DocumentUpdater |
| `SessionStore` | `services/web/app/src/Features/AiAssistant/SessionStore.mjs` | MongoDB CRUD for conversations + message persistence |
| Frontend panel | `services/web/frontend/js/features/ai-assistant/components/ai-assistant-pane.tsx` | React chat UI with SSE streaming |
| Frontend settings | `services/web/frontend/js/features/ai-assistant/components/ai-assistant-settings.tsx` | Provider settings panel (code exists, not wired into UI yet)

## Configuration Reference

Configuration lives in `develop/dev.env` (gitignored, auto-generated on first setup):

| Variable | Default | Purpose |
|----------|---------|---------|
| `AI_ASSISTANT_CLAUDE_BIN` | `claude` | Path to the Claude CLI binary inside the web container. Empty or unset disables the feature. |
| `AI_ASSISTANT_TOKEN_KEY` | auto-generated | 32-byte hex key for JWE token encryption at rest. Generate: `openssl rand -hex 32` |
| `AI_ASSISTANT_IDLE_MS` | `600000` | Idle timeout (ms) before the Claude subprocess is killed. Set to `0` to disable auto-kill. |
| `PUBLIC_URL` | — | Public-facing URL (include port if non-80). Used for webpack dev server. |
| `DOWNLOAD_HOST` | `http://clsi-nginx:8080` | CLSI download host for compiled PDFs. Docker service name. |

### Additional Settings (in `settings.defaults.js`)

The `aiAssistant` config block also supports:
- `tokenKey` — falls back to `AI_ASSISTANT_TOKEN_KEY` env var, then auto-generated
- `claudeBin` — from `AI_ASSISTANT_CLAUDE_BIN` env var
- `idleMs` — from `AI_ASSISTANT_IDLE_MS` env var, default 600000

If `claudeBin` is not set, all AI assistant endpoints return HTTP 503.

## Changes from Upstream

This fork modifies Overleaf Community Edition with the following additions:

| Area | Change |
|------|--------|
| `services/web/app/src/Features/AiAssistant/` | New module (7 files): subprocess management, OAuth, SSE, session persistence, token encryption, provider settings |
| `services/web/frontend/js/features/ai-assistant/` | New React components: chat panel, settings panel, model selector, @ file picker, session list, permission mode selector |
| `services/web/frontend/stylesheets/pages/editor/ai-assistant.scss` | Chat panel + settings styles |
| `services/web/app/src/infrastructure/ExpressLocals.mjs` | Webpack manifest fallback for production mode |
| `services/web/app/src/models/User.mjs` | `aiAssistant` subdocument: OAuth tokens, preferredModel, providers[], claudeAccount |
| `services/web/Dockerfile` | Claude CLI (`@anthropic-ai/claude-code`) installed globally in dev and production targets |
| `services/web/config/settings.defaults.js` | AI Assistant config block: `claudeBin`, `tokenKey`, `idleMs` |
| `services/clsi/Dockerfile` | (no changes — CJK support handled via texlive package installation at runtime if needed) |
| `develop/docker-compose.yml` | Added nginx reverse proxy, production-mode compose, new service names |
| `develop/nginx/nginx.conf` | SSE stream buffering disabled for `/project/*/ai-assistant/stream`, WebSocket proxy to real-time |

All modifications are released under AGPL-3.0. See [NOTICE.md](NOTICE.md) for full attribution.

### Provider Settings (Backend Code Only — Not Routed)

The file `AiAssistantSettingsController.mjs` exists on disk with full CRUD for named
provider profiles (OAuth, API key, custom relay URL), activation switching, and
connection status. It is not yet wired into the router or the React frontend.
Endpoints would be at `/ai-assistant/providers/*` once connected.

## API Endpoints

### Authentication (per-user, no project context)

| Method | Path | Handler |
|--------|------|---------|
| POST | `/ai-assistant/oauth/start` | Begin OAuth login, returns `authorizeUrl` |
| POST | `/ai-assistant/oauth/exchange` | Submit OAuth code from user |
| GET | `/ai-assistant/oauth/status` | Check connection status |
| POST | `/ai-assistant/oauth/disconnect` | Clear stored tokens and stop sessions |
| GET | `/ai-assistant/preferences` | Get preferred model |
| PUT | `/ai-assistant/preferences` | Update preferred model |

### Project-scoped (requires write access)

| Method | Path | Handler |
|--------|------|---------|
| GET | `/project/:Project_id/ai-assistant/stream` | SSE stream of session events |
| POST | `/project/:Project_id/ai-assistant/message` | Send user message to Claude |
| POST | `/project/:Project_id/ai-assistant/stop` | Kill subprocess |
| GET | `/project/:Project_id/ai-assistant/files` | List project files (for @ picker) |
| POST | `/project/:Project_id/ai-assistant/permission-response` | Approve/deny tool action |
| GET | `/project/:Project_id/ai-assistant/sessions` | List conversations |
| POST | `/project/:Project_id/ai-assistant/sessions` | Create new conversation |
| POST | `/project/:Project_id/ai-assistant/sessions/:sessionId/rename` | Rename conversation |
| DELETE | `/project/:Project_id/ai-assistant/sessions/:sessionId` | Delete conversation |
| GET | `/project/:Project_id/ai-assistant/sessions/:sessionId/messages` | Get persisted messages |
| PUT | `/project/:Project_id/ai-assistant/sessions/:sessionId/messages` | Save messages |

## Known Limitations

- **One-directional file sync**: Changes made by Claude in the working directory are pushed to Overleaf, but edits made in Overleaf's editor are **not** mirrored back to the working directory. Restarting the session re-hydrates from Overleaf.
- **Text files only**: FileSync only watches `.tex`, `.bib`, `.cls`, `.sty`, `.md`, `.txt`, `.json`, `.yaml`, `.yml` extensions. Binary files (images, PDFs) are not synced.
- **No new file creation**: Claude cannot create entirely new files in the project (the FileSync skips paths without a matching doc ID).
- **Inverse sync not implemented**: The lightweight design doc described bidirectional sync (Overleaf → CWD), but this is **not yet implemented**.
- Non-goal: Full IDE experience (use Overleaf's editor; power users can run Claude locally against a cloned repo)

## License

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

- Original Overleaf Community Edition: Copyright (c) Overleaf / WriteLaTeX Limited
- Fork modifications: Released under AGPL-3.0

See [LICENSE](LICENSE) for full terms and [NOTICE.md](NOTICE.md) for modification details.
