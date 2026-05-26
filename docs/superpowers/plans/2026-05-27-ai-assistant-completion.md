# AI Assistant Implementation Progress

## Completed

### Phase 1 — Core Chat Infrastructure ✅
- AiAssistantManager: CLI spawn, stream-json parsing, SSE fan-out
- AiAssistantController: HTTP surface (OAuth, stream, message, stop, files)
- AiAssistantRouter: route registration
- ClaudeAuth: OAuth flow via `claude auth login --claudeai`
- TokenStore + TokenCrypto: JWE encryption for OAuth tokens
- FileSync: chokidar → DocumentUpdater bidirectional sync
- React chat panel with message timeline, composer, SSE streaming
- Mode selector (4-column grid: Ask/Plan/Accept edits/Bypass)
- Markdown rendering with rounded code blocks, blockquotes, tables
- Webpack exposed on 0.0.0.0:8082 for LAN access

### Phase 2 — Enhanced Features ✅
- Enhanced @ file picker with file-type icons and directory path
- Enhanced / command palette with icons and descriptions
- Image attachments (📎 button, thumbnail preview, base64 upload)
- Permission request popup (Allow/Deny, tool name + input details)
- Inline diff cards with Revert button (`/revert-file` endpoint)
- Multi-session management (SessionList sidebar, CRUD API, MongoDB storage)
- Session list with time grouping (Today/Yesterday/earlier)
- Auto-generated session titles from first message
- Mode selector labels only (no hint text)

### Bug Fixes ✅
- OAuth URL corrected to `platform.claude.com`
- Duplicate messages fixed (removed `--include-partial-messages`)
- Webpack bind fixed to `0.0.0.0:8082`
- Orphan code-server containers cleaned up
- Server git repo fixed (removed broken worktree `.git` reference)

## Remaining Work (Phase 3)

### SSE Reconnection with History Replay
- Auto-reconnect on disconnect with `?after=<lastEventId>` param
- Server-side `history` replay on reconnect
- Currently: page reload loses all messages

### i18n
- Replace hardcoded English strings with `t()` calls
- Add missing keys to `en.json`
- Locales bind-mounted for dev updates

### Pin Claude CLI Version
- Change `@latest` to specific version in Dockerfile
- Prevents unpredictable rebuilds

### New File Creation
- FileSync currently logs "creation not supported yet" for new files
- Need: create-file endpoint that adds docs via ProjectEntityHandler

### Full Diff Rendering
- Currently shows placeholder text `(diff not available in MVP)`
- Need: actual unified diff output using `diff` package (currently devDep only)

## Key Architecture Decisions

1. **In-process subprocess** — no Docker containers per user; claude CLI spawned inside web container
2. **SSE for streaming** — not WebSocket; simple flat event model
3. **MongoDB for sessions** — `aiAssistantSessions` collection with userId/projectId/title/timestamps
4. **JWE token encryption** — `AI_ASSISTANT_TOKEN_KEY` environment variable
5. **Bidirectional file sync** — chokidar watches CLI cwd, pushes changes via DocumentUpdater
6. **Permission mode via CLI flag** — `--permission-mode` passed at spawn time
7. **Images as base64 in payload** — no separate upload endpoint for MVP
8. **Session switching = process restart** — no pause/resume; fresh CLI spawn each time

## Deployment

- **Server**: `192.168.0.6` (NEC machine)
- **Project dir**: `/home/zuens2020/overleaf-claude`
- **Docker Compose project**: `overleaf-claude`
- **Deploy**: rsync code → `docker compose -p overleaf-claude restart webpack web`
- **Access**: `http://192.168.0.6:8082`
- **OAuth**: Users connect their Claude account via in-browser PKCE flow

## Relevant Files

### Backend
- `services/web/app/src/Features/AiAssistant/AiAssistantManager.mjs` — CLI subprocess lifecycle
- `services/web/app/src/Features/AiAssistant/AiAssistantController.mjs` — HTTP endpoints
- `services/web/app/src/Features/AiAssistant/AiAssistantRouter.mjs` — route registration
- `services/web/app/src/Features/AiAssistant/SessionStore.mjs` — MongoDB session CRUD
- `services/web/app/src/Features/AiAssistant/ClaudeAuth.mjs` — OAuth flow
- `services/web/app/src/Features/AiAssistant/TokenCrypto.mjs` — JWE encryption
- `services/web/app/src/Features/AiAssistant/TokenStore.mjs` — MongoDB token storage
- `services/web/app/src/Features/AiAssistant/FileSync.mjs` — bidirectional file sync

### Frontend
- `services/web/frontend/js/features/ai-assistant/components/ai-assistant-pane.tsx` — Full React UI
- `services/web/frontend/stylesheets/pages/editor/ai-assistant.scss` — All CSS styles

### Config
- `develop/dev.env` — `AI_ASSISTANT_TOKEN_KEY`, `AI_ASSISTANT_CLAUDE_BIN`, `AI_ASSISTANT_IDLE_MS`
- `develop/docker-compose.yml` — webpack on `0.0.0.0:8082`, web with docker socket