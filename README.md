# PM2 Captain

A local, dark-mode control room for PM2 status, process details, lifecycle
actions, active log history, and live stdout/stderr.

## Requirements

- Node.js 22 or newer
- A PM2 daemon reachable through `PM2_HOME`

## Install and run

```bash
npm install
npm run build
npm link
pm2-captain
```

Captain binds only to `127.0.0.1`, prints a one-time launch URL, and opens it
when a graphical desktop is detected. It stays in the foreground; press
Ctrl+C to stop it.

```text
pm2-captain [--port 3212] [--pm2-home /path/to/.pm2] [--no-open]
```

`PM2_CAPTAIN_PORT` and `PM2_HOME` provide the corresponding environment
settings. The default port is `3212`.

If Captain already owns the selected port, a second invocation opens or prints
the existing instance and exits. A different service on the port produces a
clear conflict error.

## Development

```bash
npm run dev
npm run typecheck
npm test
npm run build
```

Development still runs one backend process. Fastify mounts Vite's middleware
and HMR; production serves `dist/frontend` from the same process.

The isolated browser suite needs Playwright Chromium once:

```bash
npx playwright install chromium
npm run test:e2e
```

## Run Captain under PM2

After `npm link`:

```bash
pm2 start pm2-captain --name pm2-captain -- --no-open
```

Captain prevents its own Stop action. Its Restart action is accepted first,
then scheduled through PM2 so the browser can reconnect.

## Security boundary

Captain is local-only. A persistent random token is stored as
`$PM2_HOME/pm2-captain-token` with mode `0600`; the printed launch URL exchanges
it for a SameSite, HttpOnly cookie. All tRPC queries, mutations, and live-log
subscriptions require that session, and cross-origin API calls are rejected.
Environment variable values are never returned by process-detail APIs.

## Log behavior

History reads the current PM2 stdout/stderr files backward with opaque
file-identity/byte-offset cursors. It handles UTF-8 boundaries, missing final
newlines, truncation, replacement, missing files, and `/dev/null` without
loading an entire file. Rotated or compressed archives are intentionally
outside v1.

Combined history uses parseable JSON or ISO timestamps where possible. If
timestamps are absent it preserves channel order and marks the result as
approximate. A shared stdout/stderr file remains readable, but historical
channel separation is unavailable.

See [REFERENCE_SOURCES.md](REFERENCE_SOURCES.md) for the Danaway/AuthoredUp
source mapping and compatibility changes.
