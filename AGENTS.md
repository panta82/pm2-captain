# PM2 Captain - Project Guidelines

## Project overview

PM2 Captain is a local web control room for PM2 daemons, local and remote (accessed via SSH). It shows PM2 process status and details, performs Start/Stop/Restart actions, and reads and streams active stdout/stderr logs.

## Architecture

The entire app is a single Node.js process:

- Fastify + tRPC API
- Self-hosted Vite middleware
- Production serves `dist/frontend` from the compiled backend.
- The `pm2-captain` binary stays in the foreground, binds to `127.0.0.1`, prints its launch URL, and opens a browser when appropriate.

Requires Node.js 22 or newer. Settings live under `~/.config/pm2-captain` (or `$XDG_CONFIG_HOME/pm2-captain`).

### Try to cherry-pick new functionality from existing TalentKit projects

The dependency injection framework, application lifecycle, targeted logger, settings shape, and backend organization are deliberately derived from AuthoredUp and similar apps.

If you need something new, look in the local environment first for checkouts of these projects, and try to grab the code from there. That help us back-propagate eventual fixes easier across projects.

### Layer boundaries

- `src/backend/framework/`: portable framework code. Nothing here may reference files outside this directory, so any piece can be moved to another project.
- `src/backend/lib/`: generic services and low-level wrappers around external systems (PM2, SSH/SFTP, files). No Captain policy.
- `src/backend/bl/`: Captain's business rules for daemons, processes, logs, and the launcher.
- `src/backend/web/`: HTTP, session, and thin tRPC routes. They validate input, map typed domain errors to tRPC errors, and delegate every decision to `bl/`.
- `src/shared/`: JSON/transport-safe types used by both backend and frontend.

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

## Security boundary

Captain is local-only, but local HTTP requests are not automatically trusted. Preserve all of these constraints:

- Bind only to `127.0.0.1`; do not add remote binding as an incidental feature.
- Keep the config directory at mode `0700`, and the launch token and daemon registry in it at `0600`. SSH arguments can carry sensitive option values.
- Exchange the launch token for a SameSite, HttpOnly session cookie, and require that session for every tRPC query, mutation, and subscription.
- Reject cross-origin mutations and do not enable CORS.
- `/launch/daemon` accepts CLI daemon handoffs only: it requires the launch token as a bearer token and rejects requests that carry an `Origin` header.
- Keep backend routes (`/health`, `/launch`, `/launch/daemon`, `/api`, `/api/trpc`) ahead of and protected from the Vite/static frontend fallback.
- Do not log launch tokens, cookies, environment values, or raw PM2 environment objects.

Any change to authentication, binding, origin checks, self-stop protection, or environment filtering is security-sensitive and requires focused tests.

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

Before handing off a material code change, run at minimum `npm run typecheck`, `npm test`, and `npm run build`. Run `npm run test:e2e` for routes, authentication, lifecycle actions, log UI, responsive behavior, or production-serving changes. When changing packaging or the CLI, also run `npm pack --dry-run`; for material packaging changes, run `npm run test:package`.

## Runtime and packaging invariants

- Preserve the CLI: `--port`, `--pm2-home`, `--no-open`, `--no-auth`, the `ssh` subcommand, `PM2_CAPTAIN_PORT`, and `PM2_HOME` as a detection hint.
- If the selected port already hosts Captain, hand off any daemon requested with `--pm2-home` or `ssh`, then open/print that instance and exit. If another service owns the port, report a clear conflict.
- Interactive execution stays in the foreground and shuts down cleanly on Ctrl+C, SIGINT, or SIGTERM.
- Keep one root package and one executable named `pm2-captain`. The packed npm artifact contains the runtime `dist` output, `install.sh`, README, and license, but no tests or development sources.

### Preparing a new release

When told to prepare a new release, the following steps should be taken:

- Update `package.json` with a new version number (decide whether to bump the patch or minor version).
- Update README.md "Version history" section with the new version number and date, then write brief bullet points describing the changes.
- Commit the changes, with a good commit messsage, containing the version number and a short description of the changes.
- Push to origin/master

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
