# PM2 Captain

Quick and simple web UI for [PM2](https://pm2.keymetrics.io/).

The equivalent of:

- `pm2 status`
- `pm2 logs`
- `pm2 info <id>`
- `pm2 env <id>`

https://github.com/user-attachments/assets/b92df2ab-5e63-4cfb-b746-7e03f4800092

Process list, Info, Env, live logs, and multi-process comparison, shown with simulated data.

## How to use

### 1. Run locally on your computer

```bash
npx pm2-captain
```

or

```
npm install -g pm2-captain
pm2-captain
```

Captain opens automatically when the system supports opening browser links;
otherwise, it prints the URL. Press Ctrl+C to stop it.

On the first launch, Captain looks for PM2 daemons on this computer (running
daemons, `PM2_HOME`, and `~/.pm2`) and adds every one it finds. To add a daemon
whose PM2 home is somewhere else, pass it on the command line:

```bash
npx pm2-captain --pm2-home /srv/pm2
```

Captain never starts or stops a PM2 daemon. It also runs fine on a computer
without PM2, for example, to watch remote servers only.

### 2. Connect to a remote server over SSH

Use the same destination and options that you pass to your system SSH client:

```bash
npx pm2-captain ssh tk-dev
npx pm2-captain --port 3213 ssh -p 2222 user@example.com
```

Captain honors your OpenSSH configuration, keys, agent, and jump hosts. It
does not install or leave anything on the remote server. PM2 control and live
logs travel through SSH-forwarded PM2 sockets; historical logs are read in
bounded ranges through the server's SFTP subsystem.

Put Captain options before `ssh`; all arguments after `ssh` are passed to the
SSH client. The remote user must be able to access its PM2 daemon and log
files. Captain discovers remote `PM2_HOME` from the remote environment, falling
back to `~/.pm2`. To use another PM2 on the same server, name its home with
`--pm2-home`; a leading `~` is the remote user's home directory:

```bash
npx pm2-captain --pm2-home '~/.pm2-staging' ssh tk-dev
```

### Managing daemons

Use the daemon picker in the top bar to add, edit and remove daemons.
Captain shows one daemon at a time; the picker next to the logo switches
between them. A daemon is identified by its PM2 home, either on this computer
or on a server reached over SSH, and you can add as many as you like, including
several on the same machine. Choose **Manage daemons…** in the picker to add,
edit, or remove them. Running `pm2-captain` with `--pm2-home` or `ssh` also adds
that daemon, including to an instance that is already running.

Daemons are remembered between launches. Removing a daemon only disconnects it
from Captain; it does not stop PM2 or any managed applications, and Captain does
not add it back on its own.

### 3. Set up as a service

In this example, we'll use PM2 (of course) and [Nginx](https://nginx.org/) as a reverse proxy.

#### Guided setup

Run the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/panta82/pm2-captain/refs/heads/master/install.sh |
  bash
```

The installer will ask you for the installation location and a few configuration options. It will then generate a `ecosystem.config.cjs` file, which you can use to add Captain to your local PM2.

For unattended setup, pass explicit options to Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/panta82/pm2-captain/refs/heads/master/install.sh |
  bash -s -- \
    --yes \
    --dir /opt/pm2-captain \
    --name pm2-captain \
    --port 3212 \
    --auth proxy
```

#### Manual setup

Create a dedicated installation and pin Captain:

```bash
mkdir -p ~/opt/pm2-captain
cd ~/opt/pm2-captain
npm init -y
npm install --save-exact pm2-captain@1
```

Create `ecosystem.config.cjs`:

```js
module.exports = {
  apps: [
    {
      name: 'pm2-captain',
      cwd: __dirname,
      script: require.resolve('pm2-captain'),
      args: ['--no-open', '--port', '3212', '--no-auth'],
      autorestart: true,
      stop_exit_codes: [78],
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
```

#### Either approach

Start the ecosystem and save the process list:

```bash
pm2 start ecosystem.config.cjs --only pm2-captain
pm2 save
```

Captain continues to listen only on `127.0.0.1`. The `--no-auth` option
delegates authentication to the reverse proxy, so the proxy must protect the
service.

The following Nginx server block terminates HTTPS, requires HTTP Basic
Authentication, and forwards regular and WebSocket traffic to Captain:

```nginx
server {
    listen 443 ssl;
    server_name captain.example.com;

    ssl_certificate /etc/letsencrypt/live/captain.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/captain.example.com/privkey.pem;

    auth_basic "PM2 Captain";
    auth_basic_user_file /etc/nginx/.pm2-captain.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:3212;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_buffering off;
    }
}
```

For example, create the password file with `htpasswd` (provided by
`apache2-utils` on Debian and Ubuntu), then validate and reload Nginx:

```bash
sudo htpasswd -c /etc/nginx/.pm2-captain.htpasswd captain
sudo nginx -t
sudo systemctl reload nginx
```

If the selected port already hosts Captain, a new `ssh` or `--pm2-home`
invocation adds the requested daemon to that running instance, then opens or
prints its URL. An invocation without a daemon simply opens or prints the
existing instance. If
another application owns the port, Captain exits with code `78`. The
`stop_exit_codes` setting prevents PM2 from repeatedly restarting a
misconfigured instance while preserving normal autorestart behavior for other
failures.

## Options

Captain can be configured via command-line options or environment variables.

### Available options

| Command-line option   | Environment variable       | Default | Description                                                                      |
| --------------------- | -------------------------- | ------- | -------------------------------------------------------------------------------- |
| `-p, --port <number>` | `PM2_CAPTAIN_PORT`         | `3212`  | HTTP port on `127.0.0.1`. In fake mode the default is `3213`.                    |
| `--pm2-home <path>`   | —                          | —       | Add the PM2 home at this path. With `ssh`, the path is on the remote server.     |
| `--open`              | —                          | Off     | Always open a browser tab, even when a restart could reuse the one already open. |
| `--no-open`           | `PM2_CAPTAIN_NO_OPEN=true` | Off     | Do not open a browser automatically.                                             |
| `--no-auth`           | `PM2_CAPTAIN_NO_AUTH=true` | Off     | Disable Captain's launch-token session. Use only behind an authenticated proxy.  |
| `--fake [scenario]`   | `PM2_CAPTAIN_FAKE`         | Off     | Show simulated PM2 daemons instead of real ones. See [Fake mode](#fake-mode).    |
| `-h, --help`          | —                          | —       | Print CLI help and exit.                                                         |

The `ssh <ssh arguments>` subcommand adds a remote PM2 daemon to Captain.
Remote daemons require the system `ssh` executable, OpenSSH stream-local
forwarding, and an enabled SFTP subsystem on the server.

`PM2_HOME` is only used to detect local PM2 daemons; it does not add one on its
own once the daemon list exists.

Command-line values take precedence over environment values. Set `DEBUG=true`
to enable diagnostic service and request logs; production output otherwise
contains only startup information and errors.

Captain keeps its own files in `~/.config/pm2-captain` (or
`$XDG_CONFIG_HOME/pm2-captain`). The directory uses mode `0700`.

1. `daemons.json` is the daemon list, with mode `0600` because saved SSH
   arguments can contain sensitive option values. Delete it, or set `daemons` to
   `null`, to have Captain detect local PM2 daemons again on the next launch.
2. `launch-token` is the persistent launch token used when authentication is
   enabled, with mode `0600`. The launch URL exchanges it for an HttpOnly,
   SameSite session cookie.

## Development

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

### Fake mode

In fake mode Captain shows simulated PM2 daemons, with processes and logs you control. It is meant for working on the UI and for tests, by people and by agents.

```bash
npm run dev:fake                         # development server, "basic" scenario
npm run dev:fake -- busy
npx pm2-captain --fake ./scenario.json   # the published CLI has it too
```

Fake mode never looks for PM2 on the computer, never runs SSH, and never reads or writes `daemons.json`. It listens on port `3213` unless told otherwise, and a fake and a real Captain refuse to stand in for each other on one port.

The built-in scenarios:

| Scenario   | What it shows                                                                           |
| ---------- | --------------------------------------------------------------------------------------- |
| `basic`    | One local daemon with online, stopped and errored processes, and slowly generated logs. |
| `busy`     | One crowded daemon: clusters, namespaces, moving CPU and memory, and fast logs.         |
| `edge`     | Every process status, long names, shared and missing log files, odd log formats.        |
| `multi`    | Local and SSH daemons, one unreachable, and one left out of the list to add by hand.    |
| `firehose` | One process writing 1,000 lines a second on top of 20,000 lines of history.             |

A scenario can also be a JSON file; `FakeScenarioSchema` in `src/backend/fake/fake_scenario.ts` describes it.

#### Controlling it

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

| Command          | What it does                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `world.reset`    | Loads a scenario (by default the one Captain started with) and resets Captain's daemon list.    |
| `daemon.set`     | Takes a daemon down or up, sets the error it reports, or slows it down.                         |
| `process.add`    | Adds a process, or a cluster with `instances`.                                                  |
| `process.remove` | Removes a process.                                                                              |
| `process.set`    | Sets any field of a process: status, metrics, restarts, log generation, the next action's fate. |
| `log.emit`       | Prints the given lines now, so they arrive live.                                                |
| `log.history`    | Replaces or extends what is already in a log file.                                              |
| `log.rotate`     | Starts a log file over, as a rotation does.                                                     |

All fields are listed in `src/backend/fake/fake_commands.ts`.

The same commands go over HTTP as JSON, one or an array of them, with the launch token as a bearer token:

```bash
curl -H "authorization: Bearer $(cat ~/.config/pm2-captain/launch-token)" \
  -H 'content-type: application/json' \
  -d '{"type":"process.set","daemon":"local","process":"api","status":"errored"}' \
  http://127.0.0.1:3213/api/fake/commands
```

`GET /api/fake/state` returns the whole fake world. Both routes exist only in fake mode.

Browser tests use the `fake` fixture from `tests/support/fake_fixture.ts`, which resets the world before each test and sends commands as typed objects; `tests/e2e/fake.test.ts` shows it in use.

## Version history

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
