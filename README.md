<h1 align="center">
  <br>
  <a href="https://www.overleaf.com"><img src="doc/logo.png" alt="Overleaf" width="300"></a>
</h1>

<h4 align="center">An open-source online real-time collaborative LaTeX editor.</h4>

<p align="center">
  <a href="https://github.com/overleaf/overleaf/wiki">Wiki</a> •
  <a href="https://www.overleaf.com/for/enterprises">Server Pro</a> •
  <a href="#contributing">Contributing</a> •
  <a href="https://mailchi.mp/overleaf.com/community-edition-and-server-pro">Mailing List</a> •
  <a href="#authors">Authors</a> •
  <a href="#license">License</a>
</p>

<img src="doc/screenshot.png" alt="A screenshot of a project being edited in Overleaf Community Edition">
<p align="center">
  Figure 1: A screenshot of a project being edited in Overleaf Community Edition.
</p>

## Claude Code AI Assistant

This fork includes a lightweight AI assistant powered by [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It adds a chat panel inside Overleaf's editor that connects to the `claude` CLI as an in-process subprocess — no Docker containers per user.

### Features

- **Chat panel** — real-time streaming conversation with Claude inside Overleaf
- **File editing** — Claude reads and edits project files, changes sync back via Overleaf's real-time pipeline
- **@ file picker** — mention files with `@`, fuzzy-filtered with file-type icons
- **/ command palette** — `/clear`, `/compact`, `/help`, `/model`, `/cost`
- **Image attachments** — attach screenshots or images to messages
- **Permission modes** — Ask (default), Plan, Accept edits, Bypass
- **Permission popup** — approve or deny individual tool actions
- **Inline diffs** — see file edits with Revert option
- **Session management** — switch between conversations, auto-titled, stored in MongoDB
- **OAuth login** — each user connects their own Claude account via in-browser PKCE flow

### Architecture

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
                               │  FileSync → DocumentUpdater    │
                               └───────────────────────────────┘
```

### Setup

1. Set `AI_ASSISTANT_TOKEN_KEY` in `dev.env` (generate with `openssl rand -hex 32`)
2. Set `AI_ASSISTANT_CLAUDE_BIN=claude` in `dev.env`
3. Install the `claude` CLI on the host or inside the web container
4. Restart: `docker compose -p overleaf-claude restart web webpack`
5. Open a project and click the Claude Code icon in the right panel

### Configuration

| Variable | Default | Description |
|---|---|---|
| `AI_ASSISTANT_TOKEN_KEY` | — | 32-byte hex key for JWE token encryption (required) |
| `AI_ASSISTANT_CLAUDE_BIN` | `claude` | Path to the claude CLI binary (empty = disabled) |
| `AI_ASSISTANT_IDLE_MS` | `600000` | Idle timeout (ms) before subprocess is killed |

### Docs

- [Lightweight redesign doc](docs/ai-assistant-lightweight-design.md) — full architecture and security model
- [Phase 2 spec](docs/superpowers/specs/2026-05-27-phase2-ai-assistant-design.md) — feature design details

## Community Edition

[Overleaf](https://www.overleaf.com) is an open-source online real-time collaborative LaTeX editor. We run a hosted version at [www.overleaf.com](https://www.overleaf.com), but you can also run your own local version, and contribute to the development of Overleaf.

> [!CAUTION]
> Overleaf Community Edition is intended for use in environments where **all** users are trusted. Community Edition is **not** appropriate for scenarios where isolation of users is required due to Sandbox Compiles not being available. When not using Sandboxed Compiles, users have full read and write access to the `sharelatex` container resources (filesystem, network, environment variables) when running LaTeX compiles.

For more information on Sandbox Compiles check out our [documentation](https://docs.overleaf.com/on-premises/configuration/overleaf-toolkit/server-pro-only-configuration/sandboxed-compiles).

## Enterprise

If you want help installing and maintaining Overleaf in your lab or workplace, we offer an officially supported version called [Overleaf Server Pro](https://www.overleaf.com/for/enterprises). It also includes more features for security (SSO with LDAP or SAML), administration and collaboration (e.g. tracked changes). [Find out more!](https://www.overleaf.com/for/enterprises)

## Keeping up to date

Sign up to the [mailing list](https://mailchi.mp/overleaf.com/community-edition-and-server-pro) to get updates on Overleaf releases and development.

## Installation

We have detailed installation instructions in the [Overleaf Toolkit](https://github.com/overleaf/toolkit/).

## Upgrading

If you are upgrading from a previous version of Overleaf, please see the [Release Notes section on the Wiki](https://github.com/overleaf/overleaf/wiki#release-notes) for all of the versions between your current version and the version you are upgrading to.

## Overleaf Docker Image

This repo contains two dockerfiles, [`Dockerfile-base`](server-ce/Dockerfile-base), which builds the
`sharelatex/sharelatex-base` image, and [`Dockerfile`](server-ce/Dockerfile) which builds the
`sharelatex/sharelatex` (or "community") image.

The Base image generally contains the basic dependencies like `wget`, plus `texlive`.
We split this out because it's a pretty heavy set of
dependencies, and it's nice to not have to rebuild all of that every time.

The `sharelatex/sharelatex` image extends the base image and adds the actual Overleaf code
and services.

Use `make build-base` and `make build-community` from `server-ce/` to build these images.

We use the [Phusion base-image](https://github.com/phusion/baseimage-docker)
(which is extended by our `base` image) to provide us with a VM-like container
in which to run the Overleaf services. Baseimage uses the `runit` service
manager to manage services, and we add our init-scripts from the `server-ce/runit`
folder.

## Contributing

Please see the [CONTRIBUTING](CONTRIBUTING.md) file for information on contributing to the development of Overleaf.

## Authors

[The Overleaf Team](https://www.overleaf.com/about)

## License

The code in this repository is released under the GNU AFFERO GENERAL PUBLIC LICENSE, version 3. A copy can be found in the [`LICENSE`](LICENSE) file.

Copyright (c) Overleaf, 2014-2025.
