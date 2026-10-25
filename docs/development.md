# PM2 Captain development guide

To set up a development environment, install Node.js 22 or newer and the
project dependencies:

```bash
npm install
npm run dev
```

Development runs one Fastify process with Vite middleware and hot module
replacement. Useful checks are:

```bash
npm run typecheck
npm test
npm run build
```

The browser suite needs Playwright Chromium. One half runs against an isolated PM2 daemon, the other against Captain in fake mode:

```bash
npx playwright install chromium
npm run test:e2e
```

## Keyboard shortcuts

The actions and their default keys are in `src/shared/keybindings.ts`, with separate defaults for the desktop app and a browser tab, which keeps more keys for itself. The backend reads the user's `keybindings.json` (`src/backend/lib/keybinding_store.ts`) and serves it as `settings.keybindings`. `KeyboardShortcutsProvider` (`src/frontend/components/keyboard_shortcuts.tsx`) matches every key press against the keys in effect, in one capture-phase window listener. Letters and digits match the typed character, or the physical key on layouts that type something else there, such as Cyrillic.

Most actions press a control: give it `data-shortcut="<action>"` and a `<ShortcutHint action="<action>" />`, the pill shown while Ctrl is held. The shortcut then does exactly what a click does, on the first such control on screen. Actions without a single control register a handler with `useShortcutHandler`. A filter box opts into Ctrl+F with `findStep`. Ctrl+F goes from box to box on screen, ordered by step and then by position (the process filter, then each log search box), and after the last one finds in the page; Ctrl+Shift+F goes back, also from the desktop find bar (`src/frontend/lib/page_find.ts`). Keys without Ctrl or Alt, such as `1` or End, are left to text boxes. An open dialog keeps every key except Ctrl+F.

## The desktop app

```bash
npm run desktop:dev                                # fake mode, "basic" scenario
PM2_CAPTAIN_DESKTOP_FAKE=multi npm run desktop:dev  # another fake scenario
npm run desktop:dev -- --real                      # the real daemon list
```

The desktop app runs the same backend code as `npm run dev`, in its own process on an OS-assigned port. Both can run at once. `--real` uses the shared `daemons.json` and ignores an inherited `PM2_CAPTAIN_DESKTOP_FAKE` value.

`desktop:dev` compiles the backend into `dist/` and serves the frontend through Vite. Frontend edits reload in place. Backend, main-process and preload edits rebuild and restart the app, including added or removed backend files. The development profile is `build/desktop/dev-profile`; set `PM2_CAPTAIN_DESKTOP_PROFILE_DIR` to use another folder.

If Electron's development binary cannot start its sandbox, add `--no-sandbox`:

```bash
npm run desktop:dev -- --no-sandbox
npm run desktop:dev -- --real --no-sandbox
```

### Architecture

Electron main holds a single-instance lock per profile and starts the backend with `utilityProcess.fork`, using Electron's Node runtime. The backend binds to `127.0.0.1` on an OS-assigned port. It generates a token per run and sends it only to main, which sets an HttpOnly, SameSite=Strict session cookie before loading the UI. Each backend run gets an in-memory browser session. The desktop app never reads or writes the npm CLI's launch-token or tab files.

The renderer has Node integration off, context isolation on, no permissions, and navigation restricted to the backend origin. Web links (http and https) open in the system browser; other schemes are blocked. The preload bridge exposes UI preferences, update controls and the find bar only to the current Captain page's main frame. Other operations use the same HTTP API as the browser UI. Packaged builds disable the RunAsNode, NODE_OPTIONS and inspector fuses, and load only from `app.asar`.

The find bar is a `WebContentsView` of its own over the window's top-right corner (`src/desktop/main/find_bar.ts`), made when first opened. It searches the Captain page with `webContents.findInPage`, like a browser's Ctrl+F; being outside the page, its text never matches itself. Its page is a script-free `data:` URL that its own sandboxed preload (`find_bar_preload.ts`) wires up. Main listens to it only on that view's `webContents.ipc`, from its main frame, and checks every value. The Captain page can only open the bar or step through matches, through the bridge. Preloads run in the renderer, so `src/desktop/preload/tsconfig.json` checks them with DOM types, which Electron main does not get.

Main restarts an unexpectedly exited backend up to three times in two minutes, without replaying process actions. On quit it stops the backend and its SSH children, escalating after ten seconds. The backend also shuts down if its parent disappears. Startup must check whether quit began while awaiting the backend or window, so it cannot resume the UI during shutdown.

Both desktop and npm Captains write the shared registry through `daemonStore.mutate`: lock, read the latest file, validate, apply the change, then save atomically. The watcher reloads external edits; invalid data preserves the last working runtimes. Daemon IDs are UUIDs. A label edit keeps the connection; a location edit replaces it and its `connectionId`, invalidating stale actions. An editor does not take the lock, so simultaneous editor and Captain saves can still conflict.

Desktop UI preferences live in the profile's `preferences.json`. The default profile is `~/.config/PM2 Captain` on Linux and `~/Library/Application Support/PM2 Captain` on macOS. Logs are in its `logs` folder. On macOS, main adds existing `/opt/homebrew/bin`, `/usr/local/bin` and `/opt/local/bin` directories to the GUI app's PATH for SSH ProxyCommand helpers.

### Linux sandbox

DEB and RPM packages install an AppArmor profile for `/opt/PM2 Captain/pm2-captain-desktop` and Chromium's setuid sandbox helper. The AppImage launcher probes user namespaces, keeps the sandbox when they work, and otherwise adds `--no-sandbox` with a log notice. It removes any flag injected by electron-builder's AppRun before making that decision. Context isolation, Node restrictions, IPC validation and HTTP authentication remain enabled in either case.

On Ubuntu 24.04 and newer, an optional AppArmor profile can allow user namespaces for one AppImage path:

```bash
sh support/desktop/appimage/apparmor-profile.sh "$HOME/Applications/PM2-Captain-x86_64.AppImage" \
  | sudo tee /etc/apparmor.d/pm2-captain-desktop-appimage
sudo apparmor_parser -r /etc/apparmor.d/pm2-captain-desktop-appimage
```

The profile uses `default_allow` with `userns`. The Ubuntu release job checks that child processes inherit access to user namespaces. Updating in place keeps the profile valid; moving or renaming the AppImage requires a new profile.

### Update implementation

The updater downloads stable releases but installs only after an explicit user action. Main stops the backend before installation because DEB/RPM replacement can change files that the backend would otherwise import later.

- macOS uses Squirrel to replace and relaunch the app.
- AppImage installation copies the verified download beside the current file, sets permissions, syncs and atomically renames it. This avoids electron-updater's delete-before-move behavior. Pre-rename failures preserve the current version.
- DEB/RPM installation verifies checksum, package name, version and architecture, then runs detached `pkexec dpkg --refuse-downgrade --install` or `pkexec rpm --upgrade`. A durable marker and `update-install.log` support recovery after a crash. No automatic package repair runs. A rejected authorization restores the backend; an uncertain installation keeps it stopped and opens recovery UI.

## Fake mode

In fake mode Captain shows simulated PM2 daemons, with processes and logs you control. It is meant for working on the UI and for tests, by people and by agents.

```bash
npm run dev:fake                         # development server, "basic" scenario
npm run dev:fake -- busy
npx pm2-captain --fake ./scenario.json   # the published CLI has it too
```

Fake mode never looks for PM2 on the computer, never runs SSH, and never reads or writes `daemons.json`: its daemon list lives in memory. The browser CLI listens on port `3213` unless told otherwise. A fake and a real Captain refuse to stand in for each other on one port. The desktop app uses an OS-assigned port.

The built-in scenarios:

| Scenario   | What it shows                                                                           |
| ---------- | --------------------------------------------------------------------------------------- |
| `basic`    | One local daemon with online, stopped and errored processes, and slowly generated logs. |
| `busy`     | One crowded daemon: clusters, namespaces, moving CPU and memory, and fast logs.         |
| `edge`     | Every process status, long names, shared and missing log files, odd log formats.        |
| `multi`    | Local and SSH daemons, one unreachable, and one left out of the list to add by hand.    |
| `firehose` | One process writing 1,000 lines a second on top of 20,000 lines of history.             |

A scenario can also be a JSON file; `FakeScenarioSchema` in `src/backend/fake/fake_scenario.ts` describes it.

### Controlling it

`pm2-captain fake <command>` talks to the Captain that runs in fake mode on the same port. The short form is `<type> [daemon [process]] [key=value …] [-- log line …]`:

```bash
pm2-captain fake state
pm2-captain fake process.set local api status=errored restarts=42
pm2-captain fake process.set local api nextActionError="Process failed to launch"
pm2-captain fake process.add local payments instances=4 history=500
pm2-captain fake process.set local api logRate=50 logProfile=json
pm2-captain fake log.emit local api channel=err -- "Something broke" "at line 2"
pm2-captain fake log.history local api file=./sample.log
pm2-captain fake log.rotate local api
pm2-captain fake daemon.set local isUp=false error="PM2 fell over"
pm2-captain fake world.reset multi
```

A daemon is named by its key in the scenario, and a process by its name or PM2 ID.

| Command                           | What it does                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `world.reset`                     | Loads a scenario (by default the one Captain started with) and resets Captain's daemon list.    |
| `daemon.set`                      | Takes a daemon down or up, sets the error it reports, or slows it down.                         |
| `process.add`                     | Adds a process, or a cluster with `instances`.                                                  |
| `process.remove`                  | Removes a process.                                                                              |
| `process.set`                     | Sets any field of a process: status, metrics, restarts, log generation, the next action's fate. |
| `log.emit`                        | Prints the given lines now, so they arrive live.                                                |
| `log.history`                     | Replaces or extends what is already in a log file.                                              |
| `log.rotate`                      | Starts a log file over, as a rotation does.                                                     |
| `registry.edit`                   | Edits a daemon in Captain's stored list from outside: `label=…` (or `label=null`), `pm2Home=…`. |
| `registry.remove`, `registry.add` | Removes a daemon from Captain's stored list, or adds the scenario's daemon back.                |
| `registry.fail`                   | Breaks the stored list: `reason=invalid`, `missing` or `unreadable`.                            |
| `registry.recover`                | Makes the stored list readable again, with the daemons it held before.                          |
| `update.set`                      | Puts the simulated desktop update into a state (see below).                                     |
| `update.install-outcome`          | What a simulated installation does: `outcome=fail` (the default) or `stay`.                     |
| `update.reset`                    | Clears the simulated update.                                                                    |

### The daemon list and updates

The `registry.*` commands change Captain's stored daemon list the way a text editor or another Captain would change `daemons.json`, so Captain's own reload runs: a renamed daemon keeps its connection, a new `pm2Home` is a new connection (an open process page goes back to the status), a removed daemon disappears, and a broken list shows a warning while the last working daemons stay. Editing a daemon while its form is open in Captain makes the form's Save report the conflict and keep the draft.

```bash
pm2-captain fake registry.edit local label="Edited outside"
pm2-captain fake registry.edit local pm2Home=/srv/elsewhere/.pm2
pm2-captain fake registry.remove local
pm2-captain fake registry.add local
pm2-captain fake registry.fail reason=invalid
pm2-captain fake registry.recover
```

The `update.*` commands drive a simulated desktop update, so the persistent update toast and its install button can be seen in the browser too. **Skip this version** hides that version. The desktop remembers the choice across restarts; **Check for Updates** in the Help menu restores the notification, and a different version appears automatically. Background checks preserve the skip. The browser simulation keeps its choice in memory until `update.reset` or `world.reset`. Nothing is downloaded or installed; a simulated installation fails unless told to stay installing.

The UI uses one updates API for state subscriptions and installation. Its frontend adapter selects trusted desktop IPC or the authenticated `updates` tRPC routes. The backend selects the `appUpdates` service through the container: a regular browser has no updates, while fake mode substitutes the simulation. Components never select fake behavior. State changes are streamed so even immediate installation failures reach the notification controller; real desktop installation stays in Electron main behind the preload bridge.

```bash
pm2-captain fake update.set status=downloaded version=9.9.9
pm2-captain fake update.set status=downloaded version=9.9.9 installKind=deb
pm2-captain fake update.install-outcome outcome=fail message="Disk full"
pm2-captain fake update.install-outcome outcome=stay
pm2-captain fake update.set status=error errorPhase=download errorMessage="Connection reset"
pm2-captain fake update.reset
```

`update.set` takes the updater's states: `idle`, `checking`, `available`, `downloading` (with `percent`), `downloaded`, `installing`, `error`, `disabled`. `pm2-captain fake state` shows the stored list under `registry` and the update under `update`; `world.reset` starts both over.

`pm2-captain fake --help` lists every command with its fields, from `FakeCommandSchema` in `src/backend/fake/fake_commands.ts`.

The same commands go over HTTP as JSON, one or an array of them, with the launch token as a bearer token:

```bash
curl -H "authorization: Bearer $(cat ~/.config/pm2-captain/launch-token)" \
  -H 'content-type: application/json' \
  -d '{"type":"process.set","daemon":"local","process":"api","status":"errored"}' \
  http://127.0.0.1:3213/api/fake/commands
```

`GET /api/fake/state` returns the whole fake world. Both routes exist only in fake mode.

Browser tests use the `fake` fixture from `tests/support/fake_fixture.ts`, which resets the world before each test and sends commands as typed objects; `tests/e2e/fake.test.ts` shows it in use.

### Controlling the desktop app

Desktop fake mode simulates updates as well as daemons. The banner, menu and install action follow the fake state without downloading, installing or restarting. The release tests can select the real updater by setting `PM2_CAPTAIN_DESKTOP_UPDATE_TEST_FEED` to a usable loopback feed; an absent or invalid feed keeps updates simulated.

In fake mode, the desktop backend writes `fake-control.json` into its profile with mode `0600` and removes it on shutdown. It contains the backend address and a separate token accepted only by fake-control routes. The session token stays in memory. Pass the control file to the CLI:

```bash
pm2-captain fake --control build/desktop/dev-profile/fake-control.json update.set status=downloaded version=9.9.9
pm2-captain fake --control build/desktop/dev-profile/fake-control.json registry.fail reason=invalid
pm2-captain fake --control build/desktop/dev-profile/fake-control.json state
```

Use your `PM2_CAPTAIN_DESKTOP_PROFILE_DIR` instead if you set a different profile.

## Building desktop packages

```bash
npm run desktop:package:linux  # DEB, RPM and AppImage in build/desktop/release
npm run desktop:package:mac    # DMG and ZIP for arm64 and x64, on macOS
npm run desktop:verify        # artifacts and update manifests
```

`npm run build` compiles the backend and UI. `npm run desktop:stage` combines that output, bundled main/preload code and production dependencies from `npm ci --omit=dev` in `build/desktop/app`. Its version comes from the root package. The npm package remains separate and has no Electron dependency.

Each Linux target gets its own electron-builder run. Concurrent builds share a directory and can overwrite the `package-type` file used to select the updater. `support/desktop/package-linux.mjs` merges the separate manifests into `latest-linux.yml`. RPM builds need `rpmbuild`.

`npm run generate:icons` generates the web icons and the Linux icon set in `support/desktop/resources/icons` from `src/frontend/public/pm2-captain-logo.png`. Keep the Linux sizes from 16 to 512 pixels: electron-builder copies a single PNG at its original size, and the 2048-pixel source logo falls outside hicolor's standard directories. KDE also uses the desktop entry's themed icon for window decorations.

The artifact verifier checks manifest sizes and SHA-512 hashes, package types, identities, fuses, contents and Linux icon sizes and paths. Linux packages must install `pm2-captain-desktop`, never shadow `/usr/bin/pm2-captain`.

## Desktop tests

```bash
npm test
npm run build && npm run desktop:stage
xvfb-run -a npm run test:desktop
node support/desktop/smoke-packaged.mjs run <path>/pm2-captain-desktop [--no-sandbox] [--real-empty]
node support/desktop/smoke-packaged.mjs fallback <extracted-AppImage>/AppRun [--real-empty]
```

Tests use temporary profile, config and home directories with simulated daemons. `--real-empty` exercises normal mode with a preseeded empty daemon list. They must never touch the developer's PM2 daemons, settings or SSH hosts.

Never execute an outer `.AppImage` locally, including for extraction: AppImageLauncher may integrate it into the home folder. Extract it with `unsquashfs` and run the extracted `AppRun`. For terminal-signal tests, keep Xvfb outside the application's process group. Killing the display causes an abrupt Electron exit rather than an orderly quit.

The smoke test's `run` mode requires OS sandbox evidence unless `--no-sandbox` is explicit: no app process with that flag, no fallback log notice, and Linux renderers in their own PID namespace with seccomp enabled. `fallback` supplies no bypass flag and requires the app to choose the fallback itself.

The release workflow defines these installed-package checks on disposable runners:

| Platform         | Checks                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ubuntu 24.04     | Install DEB, launch with sandbox, deny then grant an app-driven N-to-N+1 update, and uninstall. Test AppImage fallback with fake and empty real data, then sandboxed launch and update with the AppArmor profile. |
| Fedora container | Install RPM, launch with sandbox, upgrade with `rpm` and launch again.                                                                                                                                            |
| macOS            | Launch the signed app.                                                                                                                                                                                            |

The scripts are `support/desktop/smoke-packaged.mjs` and `support/desktop/ci/update-test.mjs`. Polkit rules control authorization in CI, so these checks do not exercise the interactive password prompt. App-driven RPM updates and Intel Mac updates need separate verification.

## Releasing

A version tag builds a draft GitHub Release. Publishing that draft releases the desktop app and triggers publication of its saved npm tarball.

1. Align `package.json` and `package-lock.json`, add the README version-history entry, run checks, then commit and push.
2. Push `v<version>`. `desktop-release.yml` verifies the versions and builds from the tag's exact commit. It tests Linux packages, the npm tarball, and Mac builds when enabled, then attaches them to a draft with update manifests and README release notes.
3. Download and try the draft's files. Publish it through GitHub's UI or your own API credentials. A publication made with a workflow's `GITHUB_TOKEN` does not trigger the npm workflow.
4. `npm-publish.yml` publishes the attached tarball through npm trusted publishing, without rebuilding it or running package scripts.

`RELEASE_PLATFORMS` in `support/release/release.mjs` selects the desktop platforms for each tagged commit. It currently contains only `linux`. The Mac job is skipped, and both draft and npm publication checks require the complete Linux asset set. Add `mac` once the signing credentials below are configured. Keep every shipped platform enabled in later releases so its updater always finds a manifest.

The draft also carries `pm2-captain-<version>-release.json`, recording the tested commit, enabled desktop platforms and npm archive checksum. Before checking out repository code, the publish job requires the run's ref and SHA, the current peeled tag, and that recorded commit to agree. It then checks out the recorded commit and verifies that the release is published, stable and complete for those platforms, and that the downloaded archive matches the metadata.

A build rerun may replace a draft's files and notes. It refuses a moved tag during the build or an already published release. Fix a published release with a higher version. Every published stable GitHub Release must include all desktop files and update manifests for its enabled platforms; a notes-only or npm-only release would break desktop update checks.

For an npm retry, run the workflow from the release tag so its provenance names the correct commit. In the UI, choose the tag under **Use workflow from**, or run:

```bash
gh workflow run npm-publish.yml --ref v2.0.0 -f tag=v2.0.0
```

An already published npm version passes only if its archive has the same integrity. A different archive or an unexpected registry error fails the job. The trusted publisher for `pm2-captain` is `panta82/pm2-captain`, workflow `npm-publish.yml`, with no environment.

Mac builds require these repository secrets:

- `MAC_CERTIFICATE`: Developer ID Application certificate.
- `MAC_CERTIFICATE_PASSWORD`.
- `APPLE_ID`.
- `APPLE_APP_SPECIFIC_PASSWORD`.
- `APPLE_TEAM_ID`.

When `mac` is enabled, missing signing credentials stop the release; production Mac builds are never unsigned.
