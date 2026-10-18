# PM2 Captain

See your [PM2](https://pm2.keymetrics.io/) apps in a web interface like this:

https://github.com/user-attachments/assets/b92df2ab-5e63-4cfb-b746-7e03f4800092

## Quick start

Instant satisfaction:

```bash
npx pm2-captain
```

or install with:

```bash
npm install -g pm2-captain
pm2-captain
```

or download one of the desktop app builds from:

#### [GitHub releases page](https://github.com/panta82/pm2-captain/releases/latest).

## What is it?

The equivalent of:

- `pm2 status`
- `pm2 logs`
- `pm2 info <id>`
- `pm2 env <id>`

in a web UI.

### Features

- Filterable process list
- Info, environment, and logs for each process
- Multiple PM2 daemons, local and remote (via SSH)
- Start/stop/restart multiple apps at once
- Filter or highlight logs, pause, download

## Desktop builds

Pick your build from the [releases page](https://github.com/panta82/pm2-captain/releases):

| Your system                   | Download                                   | Install                                 |
| ----------------------------- | ------------------------------------------ | --------------------------------------- |
| Debian or Ubuntu, x64         | `pm2-captain-desktop_<version>_amd64.deb`  | Open with your package manager.         |
| Fedora, RHEL or openSUSE, x64 | `pm2-captain-desktop-<version>.x86_64.rpm` | Open with your package manager.         |
| Other Linux, x64              | `PM2-Captain-x86_64.AppImage`              | Make the file executable, then open it. |

macOS desktop builds will follow. The npm CLI remains available on macOS.

For AppImage-s, we recommend using the [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher). Otherwise, make the AppImage executable with:

```bash
chmod +x PM2-Captain-x86_64.AppImage
```

Desktop app logs are in these folders by default:

- Linux: `~/.config/PM2 Captain/logs`, or `$XDG_CONFIG_HOME/PM2 Captain/logs` when set.

## CLI options

| Command-line option   | Environment variable       | Default | Description                                                                                      |
| --------------------- | -------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `-p, --port <number>` | `PM2_CAPTAIN_PORT`         | `3212`  | HTTP port on `127.0.0.1`. In fake mode the default is `3213`.                                    |
| `--pm2-home <path>`   | —                          | —       | Add the PM2 home at this path. With `ssh`, the path is on the remote server.                     |
| `--open`              | —                          | Off     | Always open a browser tab, even when a restart could reuse the one already open.                 |
| `--no-open`           | `PM2_CAPTAIN_NO_OPEN=true` | Off     | Do not open a browser automatically.                                                             |
| `--no-auth`           | `PM2_CAPTAIN_NO_AUTH=true` | Off     | Disable Captain's launch-token session. Use only behind an authenticated proxy.                  |
| `--fake [scenario]`   | `PM2_CAPTAIN_FAKE`         | Off     | Show simulated PM2 daemons instead of real ones. See [Fake mode](docs/development.md#fake-mode). |
| `-h, --help`          | —                          | —       | Print CLI help and exit. `ssh --help` and `fake --help` describe the subcommands.                |
|                       | `DEBUG=true`               | Off     | Enable diagnostic service and request logs.                                                      |

The `ssh <ssh arguments>` subcommand adds a remote PM2 daemon to Captain. You can also do this from the UI.

Remote daemons require a local `ssh` executable, OpenSSH stream-local forwarding, and an enabled SFTP subsystem on the server.

`PM2_HOME` is a hint for initial daemon detection. Once a daemon list is saved, use `--pm2-home` or the UI to add another daemon.

## Config

The app keeps its config file in `~/.config/pm2-captain/daemons.json` (or `$XDG_CONFIG_HOME/pm2-captain/daemons.json` when set).

The configured daemons are shared between the desktop app and any npm `pm2-captain` instances or services. The instances will sync the changes between themselves.

## Service setup

You can setup PM2 captain as a permanent service on your server.

Read [this guide](docs/service_setup.md) for details.

## Development

Read [development.md](docs/development.md) for more details.

## Version history

#### `2.2.0` (2026-10-18)

- Filtering selected processes no longer hides them from view
- Nicer version update notice, also allows you to skip a version

#### `2.1.1` (2026-10-18)

- Fix missing Linux menu and KDE title-bar icons by packaging standard icon sizes
- Verify icon sizes and paths in AppImage, DEB and RPM builds

#### `2.1.0` (2026-10-17)

- Improve cli help screen, add help for subcommands and the fake mode

#### `2.0.3` (2026-10-17)

- First desktop release for Linux: DEB, RPM and AppImage, with in-app updates
- Simulate settings-file conflicts and updates in fake mode
- macOS desktop builds will follow

#### `2.0.2` (2026-10-16)

- Fix release validation of AppImage updates

#### `2.0.1` (2026-10-16)

- Fix restarting the AppImage after installing an update

#### `2.0.0` (2026-10-16)

- Introduce PM2 Captain desktop app
- Extend "fake mode" to the desktop app

#### `1.5.0` (2026-10-15)

- Redesign Log page header - line counter is now in the header, and the anchor button is now in the lower right corner
- Allow adding multiple search fields in the Logs toolbar
- Allow toggling between filter and highlight modes for the Log search bar
- Fix the issue where the non-anchor mode would stop working after the log buffer got filled up

#### `1.4.0` (2026-10-14)

- You can now select multiple processes, to perform actions on or compare their values
- Improve the process sidebar layout and performance
- Detect lost PM2 daemon connections and reconnect automatically.
- Add `--fake` mode with simulated daemons, processes, and logs for demos and testing.

#### `1.3.1` (2026-10-10)

- Try to smartly detect whether to open a new browser tab, or reuse an existing one. User can pass `--open` to always open a new tab, or `--no-open` to never open one.

#### `1.3.0` (2026-10-10)

- Add multi-daemon support. You can now connect to multiple PM2 daemons, either on the same machine or on different servers. Use the daemon picker in the top bar to switch between them.
- Improve and standardize the UI

#### `1.2.0` (2026-08-03)

- Filter the process list from the header (same search UI as logs, with match
  highlighting)
- Show namespace on the status table; drop the watch column
- Improve mobile header layout and log/process list interaction performance

#### `1.1.1` (2026-08-02)

- Keep the process sidebar scrollable when many processes are listed
- When Captain is already running, print its URL and exit cleanly even with
  `--no-open` (only exit `78` when another app owns the port)

#### `1.1.0` (2026-07-28)

- Remember the last process tab (Info / Env / Logs) in `localStorage`
- Match Pause button size to other controls in the logs toolbar

#### `1.0.0` (2026-07-27)

Initial release.

## License

MIT
