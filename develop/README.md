# Overleaf Community Edition, development environment

## Building and running

In this `develop` directory, build the services:

```shell
bin/build
```

> [!NOTE]
> If Docker is running out of RAM while building the services in parallel, create a `.env` file in this directory containing `COMPOSE_PARALLEL_LIMIT=1`.

Then start the services:

```shell
bin/up
```

Once the services are running, open <http://localhost/launchpad> to create the first admin account.

> [!IMPORTANT]
> `dev.env` must set `DOWNLOAD_HOST=http://clsi-nginx` (with scheme).
> The bare hostname `clsi-nginx` is treated as a relative URL by
> `new URL(...)` in `web/ClsiManager._parseOutputFiles`, which then
> throws `ERR_INVALID_URL` on every compile, surfacing as a
> "Server Error" with no output.

## AI assistant (Claude Code)

The AI assistant rail panel runs the `claude` CLI as a subprocess of the
`web` service — no per-user containers, no iframe. Each Overleaf user
links their own Claude account via in-app OAuth.

Setup:

1. Generate an encryption key for stored OAuth tokens and set
   `AI_ASSISTANT_TOKEN_KEY` in `dev.env`:
   ```shell
   openssl rand -hex 32
   ```
2. Ensure the `claude` CLI is installed in the `web` image (the dev
   Dockerfile installs it). `AI_ASSISTANT_CLAUDE_BIN` controls the
   binary path; leave empty to disable the feature.

Usage:

1. Open a project, click the AI assistant icon in the right rail.
2. Click **Connect Claude** → authorize on anthropic.com → paste the
   shown code back into Overleaf.
3. Chat with Claude. File edits Claude makes are mirrored into the
   project via DocumentUpdater and appear live in the editor.

See `docs/ai-assistant-lightweight-design.md` for the full design.

## Development

To avoid running `bin/build && bin/up` after every code change, you can run Overleaf
Community Edition in _development mode_, where services will automatically update on code changes.

To do this, use the included `bin/dev` script:

```shell
bin/dev
```

This will start all services using `node --watch`, which will automatically monitor the code and restart the services as necessary.

To improve performance, you can start only a subset of the services in development mode by providing a space-separated list to the `bin/dev` script:

```shell
bin/dev [service1] [service2] ... [serviceN]
```

> [!NOTE]
> Starting the `web` service in _development mode_ will only update the `web`
> service when backend code changes. In order to automatically update frontend
> code as well, make sure to start the `webpack` service in _development mode_
> as well.

If no services are named, all services will start in development mode.

## Debugging

When run in _development mode_ most services expose a debugging port to which
you can attach a debugger such as
[the inspector in Chrome's Dev Tools](chrome://inspect/) or one integrated into
an IDE. The following table shows the port exposed on the **host machine** for
each service:

| Service            | Port |
| ------------------ | ---- |
| `web`              | 9229 |
| `clsi`             | 9230 |
| `chat`             | 9231 |
| `contacts`         | 9232 |
| `docstore`         | 9233 |
| `document-updater` | 9234 |
| `filestore`        | 9235 |
| `notifications`    | 9236 |
| `real-time`        | 9237 |
| `history-v1`       | 9239 |
| `project-history`  | 9240 |

To attach to a service using Chrome's _remote debugging_, go to
<chrome://inspect/> and make sure _Discover network targets_ is checked. Next
click _Configure..._ and add an entry `localhost:[service port]` for each of the
services you want to attach a debugger to.

After adding an entry, the service will show up as a _Remote Target_ that you
can inspect and debug.
