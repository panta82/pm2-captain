# PM2 Captain - Project Guidelines

## Project overview

PM2 Captain is a local web control room for PM2 daemons, local and remote (accessed via SSH). It shows PM2 process status and details, performs Start/Stop/Restart actions, and reads and streams active stdout/stderr logs.

It ships two ways from this one repository: the npm package `pm2-captain` (a CLI that serves the UI to a browser, also run as a service), and an Electron desktop app (DEB, RPM and AppImage for Linux, DMG/ZIP for macOS) that bundles the same backend and UI. Desktop user documentation is in `docs/desktop.md`; development, packaging and release instructions are in `docs/development.md`.

## Architecture

The npm CLI and service are a single Node.js process:

- Fastify + tRPC API
- Self-hosted Vite middleware
- Production serves `dist/frontend` from the compiled backend.
- The `pm2-captain` binary stays in the foreground, binds to `127.0.0.1`, prints its launch URL, and opens a browser when appropriate.

The desktop app is two processes: Electron main (window, menu, preferences, updates, single-instance lock) and the same backend in an Electron `utilityProcess` (`src/desktop/backend/desktop_backend.ts`, using `createDesktopBackendSettings`). The backend listens on `127.0.0.1` on an OS-assigned port with a fresh launch token per run, which it sends only to main over the typed `parentPort` protocol in `src/desktop/shared/backend_protocol.ts`. Main sets the session cookie in the window and restarts a backend that exits unexpectedly (bounded). The backend shuts down when main asks or when its parent disappears. The window is a normal Captain page; everything goes over the HTTP API except the small preload bridge (UI preferences and update controls).

Requires Node.js 22 or newer. Settings live under `~/.config/pm2-captain` (or `$XDG_CONFIG_HOME/pm2-captain`).

### Layer boundaries

- `src/backend/framework/`: portable framework code. Can only reference itself. The idea is that stuff from here can be copied into any project - it's fully generic.
- `src/backend/lib/`: generic services and low-level wrappers around external systems (PM2, SSH/SFTP, files).
- `src/backend/bl/`: project-specific business logic for daemons, processes, logs, and the launcher.
- `src/backend/web/`: the web layer - HTTP, session, and thin tRPC routes. Business logic is delegated to `bl/`.
- `src/shared/`: JSON/transport-safe types used by both backend and frontend. Can be referenced by anyone.
- `src/frontend/`: React UI, Vite config, and static assets. Separate from backend, other than shared types. Desktop-only UI talks to the preload bridge through the types in `src/shared/desktop_bridge.ts`.
- `src/backend/fake/`: fake mode (simulated daemons, processes, logs, registry and updates). Never used by real mode.
- `src/desktop/main/`: Electron main process: window, IPC sender validation (`ipc_trust.ts`), preferences, backend host, updater and the Linux/AppImage installers.
- `src/desktop/preload/`: the preload bridge, bundled into one sandboxed file.
- `src/desktop/backend/`: the utility-process entry point around the shared backend.
- `src/desktop/shared/`: types shared by main and the desktop backend (protocol, IPC channels). Not for the frontend.
- `support/desktop/`: staging, packaging, artifact verification, smoke tests, the AppImage launcher, and `dev.mjs` (`npm run desktop:dev`). `support/release/release.mjs`: release workflow helpers.

### Services

- A service is only available through the container after it is registered in `src/backend/container.ts`.
- There are two container shapes. The app container (`APP_SERVICES`) runs the web server, launcher, daemon registry, and `daemonManager`. `daemonManager` creates one daemon container (`DAEMON_SERVICES`) per daemon, holding that daemon's SSH connection, PM2 client, process manager, and log manager. Daemon services must not reach into the app container or into another daemon.
- Preserve the `initialize`, `start`, `stop`, and `dispose` lifecycle. Whatever startup acquires (listeners, timers, sockets, PM2 and SSH connections), shutdown releases.
- Use arrow functions for public service methods so binding stays predictable. Prefix internal members with `_`; do not use `private` or `protected` in the anonymous service-class pattern.

### Daemons

- The thing a user adds is a PM2 daemon, identified by its PM2 home: a local directory, or a server reached with the system `ssh` client plus an optional remote PM2 home. The host is only part of where a daemon lives. No daemon is privileged; all can be edited and removed, and several can share one machine.
- A PM2 ID is only unique within its daemon, so every process and log call carries a `daemonId`.
- In `daemons.json`, a missing file or `"daemons": null` means "never set up": on that launch only, Captain detects local PM2 daemons and saves the result, even when empty. An existing list, even an empty one, is the user's choice. Never auto-add daemons to it.
- Two daemons are the same when their location is: the resolved local path, or identical SSH arguments plus the same remote PM2 home.
- `PM2_HOME` is only a detection hint. `--pm2-home` and `ssh ...` add a daemon explicitly, including to an already running Captain.
- `daemons.json` is shared by every Captain on the machine: npm, services, and the desktop app. Every Captain change goes through `daemonStore.mutate`, which takes the `.daemons.lock` lock, rereads the newest file, applies one change, and saves atomically. Never write the file from a remembered list. Editing a daemon that changed on disk since its form was opened fails with `DaemonConflictError`.
- Captain watches `daemons.json` (debounced, plus a periodic rescan) and reloads it. A broken or missing file becomes a registry warning while the last loaded daemons stay connected; it is never overwritten. A symbolic link is refused.
- Each daemon runtime has a `connectionId`, new for every connection. A reload keeps the connection when only the label changes, and replaces it when the location changes. Process actions carry the `connectionId` they were shown from and are refused for a replaced or removed connection, so an action never lands on a different PM2.

### PM2 behavior

- Captain never starts, spawns, or stops a PM2 daemon. Before connecting to a local PM2, check for its daemon socket and ping it, because a local PM2 client starts a daemon on its own when none answers.
- Do not import the `pm2` package entry at runtime: it builds a default client that creates `~/.pm2`. Load `pm2/lib/API.js` (see `pm2_client.ts`) and import only types from `pm2`.
- Construct a local PM2 client only when `rpc.sock` exists and is readable and writable. Construction creates directories in the PM2 home, and PM2 exits the whole process when connecting fails with `EACCES`.
- Use the PM2 JavaScript API through `pm2Client`; do not shell out to the PM2 CLI for application behavior.
- Keep the callback timeouts, reconnect backoff, per-PM2-ID serialization of lifecycle actions, and listener/timer cleanup on shutdown.
- Identify Captain by its operating-system PID, not by process name. Captain may not stop itself. A Captain restart must return an accepted response before the restart is scheduled, so the browser can enter reconnect mode.
- A stopped process stays listed and is started through its existing PM2 entry. Adding, deleting, scaling, reloading, or editing apps is out of scope.

### Logs

- Historical reads cover only the active `pm_out_log_path` and `pm_err_log_path`; rotated and compressed archives are out of scope.
- Read backward in bounded byte chunks. Never load an entire log file to return one page.
- Cursors are opaque external values. Validate the decoded structure, fail safely on malformed data, and keep exhaustion per channel so combined paging cannot reread an exhausted stream.
- Combined history orders by parseable timestamps when available. Otherwise it keeps channel order and reports approximate ordering.
- The reverse reader must keep handling UTF-8 chunk boundaries, missing final newlines, huge lines, empty or missing files, `/dev/null`, truncation, rotation, and a file shared by stdout and stderr.

### Public API

Keep the tRPC surface small and stable. Whitelist process-detail fields and never pass raw PM2 process objects to the frontend. Environment variables are returned only by `processes.detail` when explicitly requested, never in lists. `daemons.list` returns stored daemon configurations, including SSH arguments, so they can be edited.

### Fake mode

- `--fake [scenario]` (and `npm run dev:fake`, `npm run desktop:dev`) shows simulated daemons. It never looks for PM2, never runs SSH, and never reads or writes the real `daemons.json`; its store is in memory but uses the production registry validation.
- The fake world is driven by commands (`process.*`, `daemon.*`, `log.*`, `world.reset`, `registry.*` for outside edits of the stored list, `update.*` for the simulated desktop update), defined in `src/backend/fake/fake_commands.ts`. `pm2-captain fake <command>` sends them to the fake Captain on the port; `/api/fake/*` exists only in fake mode.
- The desktop app in fake mode (`PM2_CAPTAIN_DESKTOP_FAKE=<scenario>`) writes `fake-control.json` (0600, removed on stop) into its profile, with its address and a separate token that only the fake routes accept; `pm2-captain fake --control <file> <command>` uses it. Its launch token never leaves the app. Desktop updates are simulated in fake mode, except in the release update test's loopback feed.

## Security boundary

Captain is local-only, but local HTTP requests are not automatically trusted. Preserve all of these constraints:

- Bind only to `127.0.0.1`; do not add remote binding as an incidental feature.
- Keep the config directory at mode `0700`, and the launch token and daemon registry in it at `0600`. SSH arguments can carry sensitive option values.
- Exchange the launch token for a SameSite, HttpOnly session cookie, and require that session for every tRPC query, mutation, and subscription.
- Reject cross-origin mutations and do not enable CORS.
- `/launch/daemon` accepts CLI daemon handoffs only: it requires the launch token as a bearer token and rejects requests that carry an `Origin` header.
- Keep backend routes (`/health`, `/launch`, `/launch/daemon`, `/api`, `/api/trpc`) ahead of and protected from the Vite/static frontend fallback.
- Do not log launch tokens, cookies, environment values, or raw PM2 environment objects.

Desktop additions:

- The desktop backend's launch token goes only to main, which sets it as the session cookie; it never appears in a URL or log, and the backend never touches the npm `launch-token`.
- Keep the window's Node integration off, context isolation and renderer sandbox on, and navigation pinned to the backend origin. IPC handlers accept only the main frame of the current Captain page (`ipc_trust.ts`).
- Keep the fuses (no RunAsNode, `NODE_OPTIONS` or inspector; load only from `app.asar`).
- Sandbox policy: DEB and RPM keep Chromium's sandbox (AppArmor profile plus setuid helper). The AppImage's `support/desktop/appimage/launcher.sh` keeps the sandbox where user namespaces work and otherwise starts with `--no-sandbox`. Main only logs "Running without the Chromium sandbox"; it does not refuse to start.
- The DEB/RPM updater installs only a package whose checksum, name, version and architecture were checked, through `pkexec dpkg --refuse-downgrade` or `pkexec rpm --upgrade`, and never runs repair commands.

Any change to authentication, binding, origin checks, self-stop protection, environment filtering, IPC trust, fuses, the sandbox policy, or the updater's install path is security-sensitive and requires focused tests.

## Frontend

- Keep the UI dark-only and use the design tokens defined in `src/frontend/styles.css`. Do not scatter replacement colors through components when a token exists.
- Structural backgrounds follow three solid levels, top to bottom: `surface-menu` (top menu rows), `surface-control` (filter and toolbar rows under them), and `surface-plane` (side menu, content, popovers, dialogs). Things placed on a plane use `panel`, `panel-hover`, and `input`. Never tint a surface with opacity; only scrims and glass overlays are translucent.
- One daemon is shown at a time, chosen with the daemon picker. Do not mix processes from several daemons in one list.
- Dots mean process status everywhere. Daemon connection state uses the server icons in `daemon_option.tsx`.
- The process filter applies on every keystroke. Only the log filter is debounced, because it runs over thousands of loaded lines.
- Put `data-component="ComponentName"` on the root DOM element rendered by every project-owned React component. The value must exactly match the source-level component name, including capitalization, so it can be searched directly in the codebase. Apply it to every DOM-rendering conditional branch. Components that render no DOM of their own, such as providers, router adapters, fragments, or components returning `null`, are exempt; do not add wrapper elements solely to mark them. Never put secrets or dynamic user data in the attribute.

## TypeScript and code style

- Do not weaken compiler options or introduce `any` to bypass a design problem.
- Use camelCase for variables/functions/fields, PascalCase for runtime classes and React components, `IPascalCase` for interfaces and other symbols that exist only in TypeScript, and SCREAMING_CASE for constants. Third-party type names and exact names required by module augmentation are exempt.
- Use descriptive names and boolean prefixes such as `isLoading`, `hasMore`, or `shouldReconnect`.
- Always use braces for control-flow statements.
- Use `/** ... */` for comments on exported types or interfaces so editors show them as documentation.
- Prefer project wrappers and established services over importing an external library throughout the codebase.
- Avoid needless one-use helpers, aliases, and abstractions. Inline simple logic when it is clearer; extract logic when it is reused or independently testable.
- Comments should explain non-obvious constraints and reasons, especially defensive handling of PM2 behavior, filesystem races, or security checks.
- Never identify an error by matching its message. Use typed errors and explicit error codes.
- Run Prettier on touched files when formatting has drifted; do not mechanically reformat unrelated files.
- Preserve user changes in a dirty worktree and avoid unrelated cleanup.

## Logging

Use the injected targeted `log` service, not ad-hoc logging inside services. The CLI may print deliberate user-facing startup information.

- `info`: human-triggered mutations and important lifecycle milestones.
- `debug`: useful operational detail and diagnostics.
- `warn`: recoverable abnormal states such as PM2 bus reconnect failures.
- `error`: failures that prevent an operation or clean startup/shutdown.

Include actionable context, but never secrets or environment values. Expected disconnects during Captain self-restart should not be reported as alarming errors.

## Testing

- All tests live under `tests/` and are named `{name}.test.ts`. Do not colocate tests in `src/`.
- `tests/unit/` holds Vitest tests and mirrors the folders of `src/`. `tests/e2e/` holds Playwright flows, which run serially against a temporary PM2 daemon and fixture process.
- Build before E2E when source changed: the E2E server serves `dist`, not source files.
- Never depend on the developer's current processes, logs, token, port, `~/.pm2`, or `~/.config/pm2-captain`. Use temporary directories and fixed timestamps.
- The E2E server uses its own `XDG_CONFIG_HOME` with a pre-seeded empty daemon list, because first-launch detection would otherwise pick up the developer's running PM2 daemons. Keep remote test daemons unreachable (for example `-p 1 127.0.0.1`) so they cannot connect to the developer's own PM2.
- Unix-socket sandbox restrictions may require approval for the isolated E2E PM2 daemon. Do not work around that by using the developer's normal PM2 home.
- Write unit tests for tricky business rules and failure modes, such as PM2 normalization, action rules, callback timeouts, reconnect and listener cleanup, cursor validation, and reverse-file edge cases. Use browser tests for complete user flows, not for small styling details.
- Desktop: `tests/unit/desktop/` holds main-process, protocol, launcher and sandbox-evidence units (part of `npm test`). `tests/e2e/desktop/` holds Electron flows against the staged app (`npm run build && npm run desktop:stage && xvfb-run -a npm run test:desktop`). `support/desktop/smoke-packaged.mjs` smoke-tests packaged builds. All use simulated daemons or an empty real list, with temporary profile, config and home directories.
- Never execute a built `.AppImage` locally: on a desktop with AppImageLauncher, that integrates it into the home folder. Extract it with `unsquashfs` and run the extracted `AppRun`.
- `tests/unit/release/` covers the release helper's failure codes and retry rules.

Before handing off a material code change, run at minimum `npm run typecheck`, `npm test`, and `npm run build`. Run `npm run test:e2e` for routes, authentication, lifecycle actions, log UI, responsive behavior, or production-serving changes. When changing packaging or the CLI, also run `npm pack --dry-run`; for material packaging changes, run `npm run test:package`. For desktop main, preload or packaging changes, run the desktop flows, and `npm run desktop:package:linux` plus `npm run desktop:verify` when packaging changes. Run `actionlint` on workflow changes.

## Runtime and packaging invariants

- Preserve the CLI: `--port`, `--pm2-home`, `--no-open`, `--no-auth`, the `ssh` subcommand, `PM2_CAPTAIN_PORT`, and `PM2_HOME` as a detection hint.
- If the selected port already hosts Captain, hand off any daemon requested with `--pm2-home` or `ssh`, then open/print that instance and exit. If another service owns the port, report a clear conflict.
- Interactive execution stays in the foreground and shuts down cleanly on Ctrl+C, SIGINT, or SIGTERM.
- Keep one root package. The npm package `pm2-captain` has one executable, `pm2-captain`, and never depends on Electron. The packed npm artifact contains the runtime `dist` output, `install.sh`, README, license and the docs listed in `files`, but no tests, desktop sources or other development sources. Link docs that are not in `files` (such as `docs/desktop.md`) from packed files with absolute GitHub URLs.
- The desktop app is staged from the same build and version into `build/desktop/app`. The Linux packages are `pm2-captain-desktop` with the command `pm2-captain-desktop` under `/opt/PM2 Captain`; they must never install `/usr/bin/pm2-captain` or shadow the npm command. The Mac app is `PM2 Captain.app`. The app ID is `com.panta82.pm2-captain`.

### Preparing a new release

When told to prepare a new release, the following steps should be taken:

- Update `package.json` and `package-lock.json` with a new version number (decide whether to bump the patch or minor version).
- Update README.md "Version history" section with the new version number and date, then write brief bullet points describing the changes. The draft release uses this entry as its notes.
- Run the checks.
- Commit the changes, with a good commit messsage, containing the version number and a short description of the changes.
- Push to origin/master

Only do this when a release is explicitly requested. What happens after that is up to the maintainer, and is never done by an agent unless told:

- Pushing the tag `v<version>` runs `desktop-release.yml`, which checks the tag, package and lock versions, builds and tests everything from the tag's exact commit, and uploads the desktop builds, update manifests and the tested npm tarball to a draft GitHub Release. It never publishes. `RELEASE_PLATFORMS` in `support/release/release.mjs` currently enables Linux only; add `mac` when signing and notarization secrets are configured. Once a platform ships, keep it enabled in later releases so its updater finds its manifest.
- The draft carries `pm2-captain-<version>-release.json` (schema 1: tag, version, tested commit, enabled platforms, npm tarball name and integrity). Draft and npm publication checks require all files for those platforms. A rerun replaces a draft's files and notes and never touches a published release.
- Publishing the draft runs `npm-publish.yml`, which publishes exactly the attached tarball to npm with trusted publishing (OIDC, no token, no rebuild, no scripts). Before anything from the repository runs, it requires the run's `GITHUB_REF` to be the tag and `GITHUB_SHA` to be the recorded commit, and the tag to still peel to it; then it checks out that commit. npm provenance records the run's ref and commit, so retries run for the tag (`gh workflow run npm-publish.yml --ref vX.Y.Z -f tag=vX.Y.Z`), never for a branch. A rerun passes only if npm already has the identical archive. npm's trusted publisher names this workflow file, so do not rename it.
- Never publish to npm by hand, and never publish a GitHub Release without the desktop files: the desktop app updates from the latest published release.

The maintainer decides per release whether it gets a testing phase. When asked to release and publish once CI passes ("fire and forget"), push the tag, then hand the rest to a cheap background subagent, so the session doesn't wait on CI:

1. Watch the tag's `desktop-release.yml` run (`gh run watch <id> --exit-status`). If it fails, stop and report the failed jobs. Never publish.
2. Check the draft: not a prerelease, and every file for the enabled platforms is attached (the desktop builds, `latest-linux.yml`, `pm2-captain-<version>.tgz`, `pm2-captain-<version>-release.json`).
3. Publish it with `gh release edit v<version> --draft=false --latest`. That starts `npm-publish.yml`. If no run appears within two minutes, start it with the retry command above.
4. Watch the npm run, confirm `npm view pm2-captain@<version> version`, and report.

Without that request, stop at the draft.

## General agent behavior

- Do not ask the user to run checks or generation steps that can be run safely in this workspace.
- Diagnose with read-only inspection before making speculative changes.
- Do not add backward-compatibility aliases or fallbacks by default. Add them only when a real shipped interface or cursor format requires them, and explain the compatibility need.
- Do not add trivial tests that merely restate framework or library behavior.
- After adding symbols, check whether each abstraction earns its existence.
- Do not commit changes unless explicitly asked.
- Keep commit messages short and outcome-focused when a commit is requested.
- If presenting several conclusions, prefer a numbered list so follow-up can refer to them precisely.

## Local overrides

Read `AGENTS.local.md` as additional project-specific guidance when it exists.
