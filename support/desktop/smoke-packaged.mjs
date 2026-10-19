// Smoke-tests a packaged desktop app from outside the checkout. Packaged apps
// have the Node inspector fuse off, so this drives the window over the Chrome
// DevTools protocol. Temporary profile, config and home directories only.
//
// Usage:
//   node support/desktop/smoke-packaged.mjs run <executable> [--no-sandbox] [--real-empty]
//     Checks the window, the bridge, the session cookie and the logs, then
//     quits and checks the backend ended. Without --no-sandbox it also
//     requires evidence of Chromium's OS sandbox. --no-sandbox is for hosts
//     where the sandbox cannot start, such as an unpacked tree without the
//     setuid helper on a system that restricts user namespaces.
//   node support/desktop/smoke-packaged.mjs fallback <executable> [--real-empty]
//     Passes no --no-sandbox and no special environment, and expects the app
//     to start without the sandbox by itself, as the AppImage does where user
//     namespaces are unavailable.
//
// The app shows simulated daemons, or with --real-empty runs in its normal
// mode with an empty daemon list preseeded in its temporary config. Run an
// AppImage's extracted AppRun, not the .AppImage file: on a desktop with
// AppImageLauncher, executing the file integrates it into the home folder.
import { chromium } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import libOs from 'node:os';
import libPath from 'node:path';

import { assessSandbox, listAppProcesses, readProcessStatus } from './sandbox-evidence.mjs';

const [mode, executable, ...options] = process.argv.slice(2);
const isRealEmpty = options.includes('--real-empty');
const isNoSandboxRequested = options.includes('--no-sandbox');
if (
  !['run', 'fallback'].includes(mode) ||
  !executable ||
  (mode === 'fallback' && isNoSandboxRequested)
) {
  console.error(
    'Usage: smoke-packaged.mjs run <executable> [--no-sandbox] [--real-empty]\n' +
      '       smoke-packaged.mjs fallback <executable> [--real-empty]'
  );
  process.exit(2);
}

const root = mkdtempSync(libPath.join(libOs.tmpdir(), 'pm2c-packaged-smoke-'));
const configHome = libPath.join(root, 'config');
// Normal mode keeps the app's own profile location, inside the temporary config.
const profile = isRealEmpty
  ? libPath.join(configHome, 'PM2 Captain')
  : libPath.join(root, 'profile');
const failures = [];
const check = (condition, message) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!condition) {
    failures.push(message);
  }
};

const freePort = () =>
  new Promise(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return null;
};

/** The backend utility processes under a main process. */
function backendPids(mainPid) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='])
    .toString()
    .trim()
    .split('\n')
    .map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, args]) => ({ pid: Number(pid), ppid: Number(ppid), args }));
  const descendants = new Set([mainPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return rows
    .filter(row => descendants.has(row.pid) && row.args.includes('node.mojom.NodeService'))
    .map(row => row.pid);
}

const readLogs = () => {
  try {
    const directory = libPath.join(profile, 'logs');
    return readdirSync(directory)
      .map(file => readFileSync(libPath.join(directory, file), 'utf8'))
      .join('\n');
  } catch {
    return '';
  }
};

// Nothing from the caller's environment may choose the app's mode or profile.
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('PM2_CAPTAIN_'))
);
const environment = {
  ...inheritedEnvironment,
  XDG_CONFIG_HOME: configHome,
  HOME: libPath.join(root, 'home'),
  ...(isRealEmpty
    ? {}
    : { PM2_CAPTAIN_DESKTOP_FAKE: 'basic', PM2_CAPTAIN_DESKTOP_PROFILE_DIR: profile }),
};
if (isRealEmpty) {
  // An existing, empty list: the app detects no local PM2 and connects to nothing.
  mkdirSync(libPath.join(configHome, 'pm2-captain'), { recursive: true, mode: 0o700 });
  writeFileSync(
    libPath.join(configHome, 'pm2-captain', 'daemons.json'),
    '{"version":1,"daemons":[]}\n',
    { mode: 0o600 }
  );
}
const appArgs = mode === 'run' && isNoSandboxRequested ? ['--no-sandbox'] : [];

async function run() {
  const debugPort = await freePort();
  const app = spawn(executable, [...appArgs, `--remote-debugging-port=${debugPort}`], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  app.stdout.on('data', chunk => (output += chunk));
  app.stderr.on('data', chunk => (output += chunk));
  const exited = new Promise(resolve => app.once('exit', resolve));
  let browser = null;
  try {
    browser = await waitFor(
      () => chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`).catch(() => null),
      30_000
    );
    check(browser !== null, 'the app accepted a DevTools connection');
    if (!browser) {
      return;
    }
    const page = await waitFor(
      () =>
        browser
          .contexts()
          .flatMap(context => context.pages())
          .find(candidate => /^http:\/\/127\.0\.0\.1:\d+\//.test(candidate.url())),
      30_000
    );
    check(Boolean(page), 'the window shows the bundled backend on a loopback port');
    if (!page) {
      return;
    }
    if (isRealEmpty) {
      await page.getByText('No PM2 daemons', { exact: true }).waitFor({ timeout: 30_000 });
      check(true, 'the window shows the empty daemon list, in normal mode');
    } else {
      await page.getByText('api', { exact: true }).first().waitFor({ timeout: 30_000 });
      check(true, 'the window lists the simulated processes');
    }
    const surface = await page.evaluate(() => ({
      bridge: Object.keys(window.pm2CaptainDesktop ?? {}),
      require: typeof window.require,
      cookie: document.cookie,
    }));
    check(surface.bridge.join(',') === 'preferences,updates,find', 'the preload bridge is present');
    check(surface.require === 'undefined', 'the page has no Node access');
    check(surface.cookie === '', 'the session cookie is HttpOnly');
    const session = await page.context().newCDPSession(page);
    const { cookies } = await session.send('Network.getAllCookies');
    const sessionCookie = cookies.find(cookie => cookie.name === 'pm2_captain_session');
    check(
      Boolean(sessionCookie?.httpOnly) && sessionCookie?.sameSite === 'Strict',
      'the session cookie is HttpOnly and SameSite=Strict'
    );
    const backends = backendPids(app.pid);
    check(backends.length === 1, 'one backend utility process runs');
    const sandboxProblems = assessSandbox({
      processes: listAppProcesses(app.pid),
      readStatus: readProcessStatus,
      platform: process.platform,
      log: readLogs() + output,
    });
    if (mode === 'fallback') {
      // Nothing here asked for it, so the app turned the sandbox off by itself.
      check(
        readLogs().includes('Running without the Chromium sandbox'),
        'the app started without the sandbox by itself, and logged it'
      );
    } else if (!isNoSandboxRequested) {
      check(
        sandboxProblems.length === 0,
        `the app runs with the OS sandbox${sandboxProblems.length ? `: ${sandboxProblems.join('; ')}` : ''}`
      );
    }

    await browser.close().catch(() => undefined);
    browser = null;
    app.kill('SIGTERM');
    const code = await Promise.race([
      exited,
      new Promise(resolve => setTimeout(() => resolve('timeout'), 20_000)),
    ]);
    check(code !== 'timeout', 'the app quit within 20 seconds');
    check(
      Boolean(await waitFor(() => backends.every(pid => !isAlive(pid)), 10_000)),
      'the backend ended with the app'
    );
    const logs = readLogs();
    check(logs.includes('Backend ready'), 'the log records the backend start');
    check(
      Boolean(sessionCookie) &&
        !logs.includes(sessionCookie.value) &&
        !output.includes(sessionCookie.value),
      'the launch token is not in the logs or output'
    );
  } finally {
    await browser?.close().catch(() => undefined);
    if (app.exitCode === null && app.signalCode === null) {
      app.kill('SIGKILL');
    }
  }
}

try {
  await run();
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
