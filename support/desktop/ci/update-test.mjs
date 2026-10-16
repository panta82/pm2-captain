// Updates an INSTALLED desktop app from version N to N+1 through a loopback
// update feed, in a disposable CI machine. The app runs with its sandbox,
// simulated daemons and a temporary profile; the installation itself is real.
// For DEB and RPM the job grants or denies pkexec with a polkit rule, so no
// password prompt is involved: this does not test the prompt itself.
//
// Usage: node update-test.mjs <executable> <feed URL> <expected version> [--expect-not-installed]
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';

import { assessSandbox, listAppProcesses, readProcessStatus } from '../sandbox-evidence.mjs';

const [executable, feedURL, expectedVersion, flag] = process.argv.slice(2);
const expectInstalled = flag !== '--expect-not-installed';
const root = mkdtempSync(libPath.join(libOs.tmpdir(), 'pm2c-update-test-'));
// Keep failure evidence in the CI log; the temporary profile disappears with
// the runner. Only the app log is read, never fake-control.json or its token.
process.on('uncaughtExceptionMonitor', () => {
  const path = libPath.join(root, 'profile', 'logs', 'main.log');
  if (existsSync(path)) {
    console.error(readFileSync(path, 'utf8').slice(-20_000));
  }
});

const waitFor = async (predicate, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate().catch(() => null);
    if (value) {
      return value;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/** The open pages that show a Captain backend. */
const captainPages = browser =>
  browser
    .contexts()
    .flatMap(context => context.pages())
    .filter(
      candidate => !candidate.isClosed() && /^http:\/\/127\.0\.0\.1:\d+\//.test(candidate.url())
    );

/**
 * Each app gets its own DevTools port. The replacement can start before the
 * old instance has released its listening socket. A fixed port then fails to
 * bind even though the replacement app itself starts successfully.
 */
const connect = (previousEndpoint = null) =>
  waitFor(
    async () => {
      const [port, path] = readFileSync(
        libPath.join(root, 'profile', 'DevToolsActivePort'),
        'utf8'
      ).split('\n');
      if (!/^\d+$/.test(port) || !/^\/devtools\/browser\/[a-f0-9-]+$/.test(path)) {
        return null;
      }
      const endpoint = `ws://127.0.0.1:${port}${path}`;
      if (endpoint === previousEndpoint) {
        return null;
      }
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
      try {
        const page = captainPages(browser)[0];
        if (page) {
          await page.waitForFunction(() => window.pm2CaptainDesktop, null, { timeout: 5000 });
          return { browser, page, endpoint };
        }
      } catch {
        // The window or its preload may still be starting.
      }
      await browser.close().catch(() => undefined);
      return null;
    },
    90_000,
    'the app window'
  );

const updateState = page => page.evaluate(() => window.pm2CaptainDesktop.updates.getState());

const app = spawn(executable, ['--remote-debugging-port=0'], {
  env: {
    // No --no-sandbox: assertSandboxed() checks that these runs have the sandbox.
    ...process.env,
    PM2_CAPTAIN_DESKTOP_FAKE: 'basic',
    PM2_CAPTAIN_DESKTOP_PROFILE_DIR: libPath.join(root, 'profile'),
    PM2_CAPTAIN_DESKTOP_UPDATE_TEST_FEED: feedURL,
    XDG_CONFIG_HOME: libPath.join(root, 'config'),
  },
  stdio: 'inherit',
});
const exited = new Promise(resolve => app.once('exit', resolve));

/** Identify the connected main process, not another app's command line. */
const mainProcessId = async () => {
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const owner = processInfo.find(process => process.type === 'browser');
    if (!owner) {
      throw new Error('The connected app did not report its main process.');
    }
    return owner.id;
  } finally {
    await session.detach();
  }
};

/** The connected instance and its descendants must be sandboxed. */
const assertSandboxed = async () => {
  const problems = assessSandbox({
    processes: listAppProcesses(await mainProcessId()),
    readStatus: readProcessStatus,
    platform: process.platform,
    log: '',
  });
  if (problems.length) {
    throw new Error(`The app runs without its OS sandbox: ${problems.join('; ')}`);
  }
};

let { browser, page, endpoint } = await connect();
await assertSandboxed();
const before = await updateState(page);
console.log(
  `Running ${before.currentVersion} (${before.installKind}); updating to ${expectedVersion}`
);
await page.evaluate(() => window.pm2CaptainDesktop.updates.check());
await waitFor(
  async () => (await updateState(page)).status === 'downloaded',
  180_000,
  'the update download'
);
await page.evaluate(() => void window.pm2CaptainDesktop.updates.install());

if (expectInstalled) {
  await Promise.race([
    exited,
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('The app did not exit to update')), 180_000).unref()
    ),
  ]);
  await browser.close().catch(() => undefined);
  // Wait for a new endpoint, never a stale file left by the previous instance.
  ({ browser, page, endpoint } = await connect(endpoint));
  const after = await updateState(page);
  await assertSandboxed();
  if (after.currentVersion !== expectedVersion) {
    throw new Error(`Expected ${expectedVersion} after the update, found ${after.currentVersion}`);
  }
  await page.getByText('api', { exact: true }).first().waitFor({ timeout: 30_000 });
  console.log(`Updated to ${after.currentVersion}; the new version shows the backend.`);
} else {
  // Restoring the backend replaces the window: a new backend run gets a new
  // window in a new session, and the old page is destroyed.
  const originalPage = page;
  let connectedAt = Date.now();
  const refused = await waitFor(
    async () => {
      // New windows normally appear on this connection; reconnect now and
      // then in case one does not.
      if (Date.now() - connectedAt > 15_000) {
        await browser.close().catch(() => undefined);
        browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
        connectedAt = Date.now();
      }
      for (const candidate of captainPages(browser)) {
        if (candidate === originalPage) {
          continue;
        }
        const state = await updateState(candidate).catch(() => null);
        if (state?.status === 'downloaded' && state.error?.phase === 'install') {
          page = candidate;
          return state;
        }
      }
      return null;
    },
    180_000,
    'the restored Captain window after the refused installation'
  );
  if (app.exitCode !== null || app.signalCode !== null) {
    throw new Error('The app exited after a refused installation instead of carrying on.');
  }
  if (refused.currentVersion !== before.currentVersion) {
    throw new Error(
      `Expected ${before.currentVersion} to keep running, found ${refused.currentVersion}`
    );
  }
  await page.getByText('api', { exact: true }).first().waitFor({ timeout: 60_000 });
  await assertSandboxed();
  console.log(
    `Not installed, as expected: ${refused.error.message} ${refused.currentVersion} carries on with a new backend at ${new URL(page.url()).origin}.`
  );
}

const currentMainPid = await mainProcessId();
await browser.close().catch(() => undefined);
process.kill(currentMainPid, 'SIGTERM');
