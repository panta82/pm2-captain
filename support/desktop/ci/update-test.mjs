// Updates an INSTALLED desktop app from version N to N+1 through a loopback
// update feed, in a disposable CI machine. The app runs with its sandbox,
// simulated daemons and a temporary profile; the installation itself is real.
// For DEB and RPM the job grants or denies pkexec with a polkit rule, so no
// password prompt is involved: this does not test the prompt itself.
//
// Usage: node update-test.mjs <executable> <feed URL> <expected version> [--expect-not-installed]
import { chromium } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import libOs from 'node:os';
import libPath from 'node:path';

import { assessSandbox, listAppProcesses, readProcessStatus } from '../sandbox-evidence.mjs';

const [executable, feedURL, expectedVersion, flag] = process.argv.slice(2);
const expectInstalled = flag !== '--expect-not-installed';
const root = mkdtempSync(libPath.join(libOs.tmpdir(), 'pm2c-update-test-'));

const freePort = () =>
  new Promise(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
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

/** The Captain page of whichever app instance listens on the DevTools port. */
const connect = port =>
  waitFor(
    async () => {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = browser
        .contexts()
        .flatMap(context => context.pages())
        .find(candidate => /^http:\/\/127\.0\.0\.1:\d+\//.test(candidate.url()));
      if (!page) {
        await browser.close();
        return null;
      }
      await page.waitForFunction(() => window.pm2CaptainDesktop, null, { timeout: 30_000 });
      return { browser, page };
    },
    90_000,
    'the app window'
  );

const updateState = page => page.evaluate(() => window.pm2CaptainDesktop.updates.getState());

const port = await freePort();
const app = spawn(executable, [`--remote-debugging-port=${port}`], {
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

/** The instance on the DevTools port, and its descendants, must be sandboxed. */
const assertSandboxed = () => {
  const owner = execFileSync('ps', ['-A', '-o', 'pid=,args='])
    .toString()
    .split('\n')
    .find(line => line.includes(`--remote-debugging-port=${port}`) && !line.includes('--type='));
  const problems = owner
    ? assessSandbox({
        processes: listAppProcesses(Number(owner.trim().split(/\s+/)[0])),
        readStatus: readProcessStatus,
        platform: process.platform,
        log: '',
      })
    : ['the app process was not found'];
  if (problems.length) {
    throw new Error(`The app runs without its OS sandbox: ${problems.join('; ')}`);
  }
};

let { browser, page } = await connect(port);
assertSandboxed();
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
      setTimeout(() => reject(new Error('The app did not exit to update')), 180_000)
    ),
  ]);
  await browser.close().catch(() => undefined);
  // The new version starts with the same arguments, so it listens on the same port.
  ({ browser, page } = await connect(port));
  const after = await updateState(page);
  assertSandboxed();
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
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
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
  assertSandboxed();
  console.log(
    `Not installed, as expected: ${refused.error.message} ${refused.currentVersion} carries on with a new backend at ${new URL(page.url()).origin}.`
  );
}

await browser.close().catch(() => undefined);
// End whichever instance is running now: the one that owns the DevTools port.
const owner = execFileSync('ps', ['-A', '-o', 'pid=,args='])
  .toString()
  .split('\n')
  .find(line => line.includes(`--remote-debugging-port=${port}`) && !line.includes('--type='));
if (owner) {
  process.kill(Number(owner.trim().split(/\s+/)[0]), 'SIGTERM');
}
