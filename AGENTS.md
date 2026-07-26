# PM2 Captain - Project Guidelines

## Project overview

PM2 Captain is a local web control room for a single PM2 daemon. It shows PM2
process status and details, performs Start/Stop/Restart actions, and reads and
streams active stdout/stderr logs.

The application is intentionally one Node.js process:

- Fastify serves the tRPC API and frontend.
- Development mounts Vite middleware and HMR into Fastify.
- Production serves `dist/frontend` from the compiled backend.
- The `pm2-captain` binary stays in the foreground, binds to `127.0.0.1`, prints
  its launch URL, and opens a browser when appropriate.

Node.js 22 or newer is required. PM2 is selected through `PM2_HOME` or
`--pm2-home`.

## Project structure

```text
src/
├── backend/
│   ├── app.ts                 # CLI/server entry point and signal handling
│   ├── backend_settings.ts    # CLI, environment, and runtime settings
│   ├── container.ts           # Service registration and typed DI container
│   ├── framework/             # Custom framework code. Nothing here should reference files outside this directory. The goal is that any piece of code can be seamlessly moved to another project.
│   ├── lib/                   # Generic services and external-system wrappers
│   ├── bl/                    # Captain-specific business logic
│   └── web/                   # Fastify, session protection, and thin tRPC routes
├── frontend/
│   ├── components/            # Shared UI and process controls
│   ├── lib/                   # Typed tRPC client and frontend utilities
│   ├── pages/                 # Status, process info, and log screens
│   ├── public/                # Static assets
│   ├── root.tsx               # TanStack route tree and application shell
│   └── styles.css             # Tailwind theme and global styles
└── shared/
    └── contracts.ts           # Transport-safe backend/frontend contracts

support/                       # Production build scripts
test/e2e/                      # Playwright browser flows
test/fixtures/                 # PM2 fixture processes
test/support/                  # Isolated E2E server setup
dist/backend/                  # Compiled backend
dist/frontend/                 # Built frontend
```

## Architecture

### Try to cherry-pick new functionality from existing TalentKit projects

The dependency injection framework, application lifecycle, targeted logger,
settings shape, and backend organization are deliberately derived from
AuthoredUp and similar apps.

If you need something new, look in the local environment first for checkouts of these
projects, and try to grab the code from there. That help us back-propagate eventual
fixes easier across projects.

### Services and dependency injection

- Register backend services in `src/backend/container.ts`. Service types become
  available through the container only after registration.
- Services receive the typed container as their only constructor argument and
  are exported with `define(...)`.
- Container instance names are camelCase (`processManager`); service names used
  by logging/settings follow the existing framework behavior.
- Preserve the `initialize`, `start`, `stop`, and `dispose` lifecycle. Acquire
  resources during startup and release listeners, timers, sockets, PM2
  connections, and web-server resources during shutdown.
- Prefer arrow functions for public service methods so method binding remains
  predictable.
- Prefix internal service members with `_`. Do not introduce `private` or
  `protected` members into the established anonymous service-class pattern.
- Keep transport handlers thin. `src/backend/web/` validates input, maps typed
  domain errors to tRPC errors, and delegates decisions to `bl/`.

### Layer boundaries

- `framework/`: portable application framework code only.
- `lib/`: generic filesystem readers and low-level wrappers around PM2 or other
  external libraries.
- `bl/`: PM2 process rules, log merging/paging, Captain self-identification,
  singleton behavior, and launcher decisions.
- `web/`: HTTP/session concerns and the public tRPC surface.
- `shared/`: JSON/transport-safe types used by both backend and frontend.

PM2-specific policy must not leak into generic file-reading code. Fastify/tRPC
procedures must not become a second business-logic layer.

### PM2 behavior

- Maintain one PM2 connection and one PM2 event bus per Captain server.
- Use the PM2 JavaScript API through `pm2Client`; do not shell out to the PM2
  CLI for application behavior.
- Wrap callback APIs with bounded timeouts and preserve reconnect backoff.
- Remove event listeners and reconnect timers on shutdown.
- Serialize conflicting lifecycle actions for the same PM2 ID.
- Identify Captain by its operating-system PID, not by process name.
- Captain may not stop itself. Captain restart must return an accepted response
  before scheduling the restart so the browser can enter reconnect mode.
- A stopped process remains listed and is started through the existing PM2
  entry. Adding, deleting, scaling, reloading, or editing apps is outside the
  current scope.

### Logs

- Historical reads operate only on active `pm_out_log_path` and
  `pm_err_log_path`; rotated and compressed archives are outside v1.
- Read backward in bounded byte chunks. Never load an entire log file merely to
  return one page.
- Cursors are opaque external values. Validate decoded structure and fail
  safely on malformed data.
- Preserve cursor exhaustion per channel so combined paging cannot reread and
  duplicate an exhausted stream.
- Handle UTF-8 chunk boundaries, missing final newlines, huge lines, empty or
  missing files, `/dev/null`, truncation, replacement/rotation, and shared
  stdout/stderr files.
- Combined history uses parseable timestamps when available. Otherwise preserve
  channel order and report approximate ordering.
- Live events must retain PM2 ID/name, stdout/stderr channel, receive order, and
  event timestamp.

### Public API

Keep the typed tRPC surface small and stable:

- `processes.list`
- `processes.detail`
- `processes.action`
- `logs.page`
- `logs.stream`

Whitelist process-detail fields. Never pass raw PM2 process objects to the
frontend, and never expose environment-variable values.

## Security boundary

Captain is local-only, but local HTTP requests are not automatically trusted.
Preserve all of these constraints:

- Bind only to `127.0.0.1`; do not add remote binding as an incidental feature.
- Store the persistent launch token below `PM2_HOME` with mode `0600`.
- Exchange the launch token for a SameSite, HttpOnly session cookie.
- Require the session for every tRPC query, mutation, and subscription.
- Reject cross-origin mutations and do not enable CORS.
- Do not log launch tokens, cookies, environment values, or complete raw PM2
  environment objects.
- Keep backend routes (`/health`, `/launch`, `/api`, `/api/trpc`) ahead of and
  protected from the Vite/static frontend fallback.

Any change to authentication, binding, origin checks, self-stop protection, or
environment filtering is security-sensitive and requires focused tests.

## Frontend

- Use React, strict TypeScript, Tailwind CSS, TanStack Router/Query/Table/Virtual,
  the typed tRPC client, Lucide icons, and Sonner notifications.
- Keep the UI dark-only and use the design tokens already defined in
  `src/frontend/styles.css`. Do not scatter replacement brand colors through
  components when a token exists.
- Put `data-component="ComponentName"` on the root DOM element rendered by every
  project-owned React component. The value must exactly match the source-level
  component name, including capitalization, so it can be searched directly in
  the codebase. Apply it to every DOM-rendering conditional branch. Components
  that render no DOM of their own, such as providers, router adapters, fragments,
  or components returning `null`, are exempt; do not add wrapper elements solely
  to mark them. Never put secrets or dynamic user data in the attribute.

## TypeScript and code style

- TypeScript is strict. Do not weaken compiler options or introduce `any` to
  bypass a design problem.
- Use camelCase for variables/functions/fields, PascalCase for runtime classes
  and React components, `IPascalCase` for interfaces and other symbols that
  exist only in TypeScript, and SCREAMING_CASE for constants. Third-party type names
  and exact names required by module augmentation are exempt.
- Use descriptive names and boolean prefixes such as `isLoading`,
  `hasMore`, or `shouldReconnect`.
- Always use braces for control-flow statements.
- Use `/** ... */` for comments on exported types or interfaces so editors show
  them as documentation.
- Prefer project wrappers and established services over importing an external
  library throughout the codebase.
- Avoid needless one-use helpers, aliases, and abstractions. Inline simple logic
  when it is clearer; extract logic when it is reused or independently
  testable.
- Comments should explain non-obvious constraints and reasons, especially
  defensive handling of PM2 behavior, filesystem races, or security checks.
- Never identify an error by matching its message. Use typed errors and explicit
  error codes.
- Follow `.prettierrc.yaml`. Run Prettier on touched files when formatting has
  drifted; do not mechanically reformat unrelated files.
- Preserve user changes in a dirty worktree and avoid unrelated cleanup.

## Logging

Use the injected targeted `log` service, not ad-hoc logging inside services.
The CLI may print deliberate user-facing startup information.

- `info`: human-triggered mutations and important lifecycle milestones.
- `debug`: useful operational detail and diagnostics.
- `warn`: recoverable abnormal states such as PM2 bus reconnect failures.
- `error`: failures that prevent an operation or clean startup/shutdown.

Include actionable context, but never secrets or environment values. Expected
disconnects during Captain self-restart should not be reported as alarming
errors.

## Development workflow

```bash
npm run dev          # One Fastify process with Vite/HMR mounted
npm run typecheck    # Backend and frontend strict type-check
npm test             # Vitest unit tests
npm run build        # Build dist/backend and dist/frontend
npm run test:e2e     # Isolated PM2_HOME + Playwright browser flows
```

- Unit tests use Vitest and colocated `*.spec.ts` files.
- Browser tests live in `test/e2e/` and run serially against a temporary PM2
  daemon and fixture process.
- Build before E2E when frontend/backend source changed: the E2E server serves
  `dist`, not source files.
- Unix-socket sandbox restrictions may require approval for the isolated PM2
  E2E daemon. Do not work around that by using the developer's normal PM2 home.
- Use fixed timestamps and temporary directories in tests. Never depend on the
  developer's current processes, logs, token, port, or `~/.pm2`.
- Add focused unit tests for PM2 normalization, action rules, callback timeouts,
  reconnect/listener cleanup, cursor validation, and reverse-file edge cases.
- Use browser tests for complete user flows and responsive/action availability,
  not for every small styling detail.
- When changing packaging or the CLI, also run `npm pack --dry-run`; for
  material packaging changes, install the tarball into a temporary prefix and
  smoke-test the compiled binary.

Always run the tests appropriate to the change. Before handing off a material
code change, run at minimum `npm run typecheck`, `npm test`, and
`npm run build`. Run E2E for routes, authentication, lifecycle actions, log UI,
responsive behavior, or production-serving changes.

## Runtime and packaging invariants

- Production output is split into `dist/backend` and `dist/frontend`.
- Do not emit tests or TypeScript declaration-input files as backend JavaScript.
- Keep one root package and one executable named `pm2-captain`.
- Preserve `--port`, `--pm2-home`, `--no-open`, `PM2_CAPTAIN_PORT`, and
  `PM2_HOME` behavior.
- If the selected port already hosts Captain, open/print that instance and exit.
  If another service owns it, report a clear conflict.
- Interactive execution remains in the foreground and shuts down cleanly on
  Ctrl+C, SIGINT, or SIGTERM.
- The packed npm artifact must include runtime `dist` output, README, license,
  and source-reference documentation, but not tests or development sources.

## General agent behavior

- Do not ask the user to run checks or generation steps that can be run safely
  in this workspace.
- Diagnose with read-only inspection before making speculative changes.
- Do not add backward-compatibility aliases or fallbacks by default. Add them
  only when a real shipped interface or cursor format requires them, and explain
  the compatibility need.
- Prefer tests for tricky business rules and failure modes. Do not add trivial
  tests that merely restate framework or library behavior.
- After adding symbols, check whether each abstraction earns its existence.
- Do not commit changes unless explicitly asked.
- Keep commit messages short and outcome-focused when a commit is requested.
- If presenting several conclusions, prefer a numbered list so follow-up can
  refer to them precisely.

## Local overrides

Read `AGENTS.local.md` as additional project-specific guidance when it exists.
