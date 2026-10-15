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
