# NOTICE

## Original Work

This project is a fork of Overleaf Community Edition:

- **Original project:** [overleaf/overleaf](https://github.com/overleaf/overleaf)
- **Copyright:** Overleaf / WriteLaTeX Limited and contributors
- **License:** GNU Affero General Public License v3.0 (AGPL-3.0)

The original LICENSE text is preserved in full in the [LICENSE](LICENSE) file.

## Modifications

This fork adds an integrated Claude Code AI assistant to Overleaf. Modifications were made
between May 2025 and May 2026.

Key modified areas:

| Directory / File | Description |
|---|---|
| `services/web/app/src/Features/AiAssistant/` | New AI assistant module (Claude CLI integration, OAuth, SSE streaming, session persistence, token encryption) |
| `services/web/frontend/js/features/ai-assistant/` | React components: chat panel, model selector, @ file picker, session list, permission mode selector |
| `services/web/app/src/models/User.mjs` | Added `aiAssistant` subdocument |
| `services/web/config/settings.defaults.js` | AI Assistant configuration block |
| `services/web/Dockerfile` | Claude CLI installation in image |
| `services/web/app/src/infrastructure/ExpressLocals.mjs` | Webpack manifest fallback for production |
| `services/clsi/Dockerfile` | CJK font and language support |
| `develop/docker-compose.yml` | Production-mode deployment with nginx proxy |
| `develop/nginx/nginx.conf` | SSE + WebSocket proxy configuration |

All modifications are released under the same AGPL-3.0 license as the original work.
The full source code of this modified version is available at:

**https://github.com/ZUENS2020/overleaf-with-claude**
