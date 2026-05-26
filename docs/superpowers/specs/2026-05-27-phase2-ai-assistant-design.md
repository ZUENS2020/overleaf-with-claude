# Phase 2 AI Assistant Design Spec

## Overview

Extend the lightweight in-process Claude Code chat with features inspired by the VS Code Claude Code extension.

## Features

### 1. @ File Mention Selector (Enhanced) ✅

**Design:** 
- Card-style dropdown with file type icons (`.tex` → description, `.bib` → menu_book, etc.)
- Directory path shown in muted color below filename
- Client-side fuzzy filtering
- Active item highlighted with accent background
- Arrow keys navigate, Enter/Tab selects

### 2. / Command Palette (Enhanced) ✅

**Design:**
- Card-style list with icon + description
- Active item highlighted with accent background
- Arrow keys navigate, Enter/Tab selects
- Commands: /clear, /compact, /help, /model, /cost

### 3. Image Attachment ✅

**Design:**
- Paperclip button in composer actions area
- Native file picker (accepts image types: png, jpg, gif, svg, webp)
- Selected images shown as thumbnails above textarea
- Each thumbnail has a remove (×) button
- Images sent as base64 in message payload
- Backend: `AiAssistantManager.send()` converts images to `{type: 'image', source: {type: 'base64', media_type, data}}` content blocks

### 4. Multi-Session Management ✅

**Design:**
- Session list sidebar overlay (triggered by ☰ button in header)
- Each session shows title (auto-generated from first message, up to 80 chars)
- Sessions grouped by time: Today, Yesterday, earlier dates
- Current session highlighted with accent background
- Hover reveals delete button (🗑)
- Click session to switch (stops current process, starts fresh)
- "New conversation" ＋ button in header creates a new session record
- Sessions persisted in MongoDB (`aiAssistantSessions` collection)
- CRUD API endpoints:
  - `GET /project/:id/ai-assistant/sessions` — list sessions
  - `POST /project/:id/ai-assistant/sessions` — create session
  - `POST /project/:id/ai-assistant/sessions/:sessionId/rename` — rename
  - `DELETE /project/:id/ai-assistant/sessions/:sessionId` — delete

### 5. Permission Request Popup ✅

**Design:**
- Inline card in chat when Claude emits a `permission-request` event
- Shows: tool name, file/command input, description, Accept/Deny buttons
- Frontend sends approval/denial via `POST /project/:id/ai-assistant/permission-response`
- Backend writes response to CLI subprocess stdin

### 6. Inline Diff Accept/Reject UI ✅

**Design:**
- When FileSync detects a change, emits `file-diff` SSE event with path and hunks
- Frontend shows collapsible diff card under the tool_use card
- Diff card has Revert button
- Revert calls `POST /project/:id/ai-assistant/revert-file` with `{path}`
- Backend uses `DocumentUpdater.setDocument` to restore original content

### Mode Selector ✅

- 4-column grid of rounded cards: Ask / Plan / Accept edits / Bypass
- Labels only (no hint text) — matches latest design
- Active mode highlighted with accent color background and border

## Architecture Decisions

1. **No new npm dependencies** — use what's already in the project
2. **SSE events stay flat** — no nested structures, keep the simple event model
3. **Backend state**: Session metadata persisted in MongoDB; CLI subprocess state stays in-process (memory)
4. **Images encoded as base64 in message payload** — no separate upload endpoint needed for MVP
5. **Session switching kills process** — no true pause/resume; each session is a fresh CLI spawn
6. **Session titles auto-generated** — first message text (truncated to 80 chars)

## Event Flow

SSE events from server:
- `status { state: 'starting'|'running'|'stopped' }`
- `assistant-message { text }`
- `thinking { text }`
- `tool-use { id, name, input }`
- `tool-result { id, output, isError }`
- `todos { todos }`
- `permission-request { id, tool, input, description }`
- `file-changed { path }`
- `file-diff { path, hunks, id }`
- `turn-end { usage?, cost? }`
- `error { message }`

HTTP endpoints:
- `POST /project/:id/ai-assistant/message` — send user message `{text, permissionMode, images?}`
- `POST /project/:id/ai-assistant/stop` — stop CLI subprocess
- `GET /project/:id/ai-assistant/stream` — SSE event stream
- `GET /project/:id/ai-assistant/files` — list project files for @ picker
- `POST /project/:id/ai-assistant/permission-response` — `{id, allow}`
- `POST /project/:id/ai-assistant/revert-file` — `{path}`
- `GET /project/:id/ai-assistant/sessions` — list sessions
- `POST /project/:id/ai-assistant/sessions` — create session `{title?}`
- `POST /project/:id/ai-assistant/sessions/:sessionId/rename` — `{title}`
- `DELETE /project/:id/ai-assistant/sessions/:sessionId` — delete session
- `POST /ai-assistant/oauth/start` — begin OAuth flow
- `POST /ai-assistant/oauth/exchange` — exchange code for tokens
- `GET /ai-assistant/oauth/status` — check connection status
- `POST /ai-assistant/oauth/disconnect` — clear tokens

## Backend Files

- `AiAssistantManager.mjs` — CLI subprocess lifecycle, event parsing, send(), respondPermission()
- `AiAssistantController.mjs` — HTTP endpoints including session CRUD, permission response, revert, images
- `AiAssistantRouter.mjs` — route registration
- `SessionStore.mjs` — MongoDB CRUD for session metadata
- `ClaudeAuth.mjs` — OAuth flow via `claude auth login --claudeai`
- `TokenCrypto.mjs` — JWE encryption for token storage
- `TokenStore.mjs` — MongoDB-backed token storage
- `FileSync.mjs` — bidirectional file sync with onFileChanged callback

## Frontend Files

- `ai-assistant-pane.tsx` — Full React UI (panel header, session list, message timeline, composer, pickers, permission cards, diff cards, mode selector)

## Configuration

- `AI_ASSISTANT_TOKEN_KEY` — 32-byte hex key for JWE token encryption (in `dev.env`)
- `AI_ASSISTANT_CLAUDE_BIN` — path to claude CLI binary (default: `claude`)
- `AI_ASSISTANT_IDLE_MS` — idle timeout in ms before subprocess is killed (default: 600000)