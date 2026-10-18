import { type ElectronApplication, type Page, _electron, expect, test } from '@playwright/test';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { promisify } from 'node:util';

const rootDir = libPath.resolve(__dirname, '../../..');
const appDir = libPath.join(rootDir, 'build/desktop/app');
const electronPath = libPath.join(rootDir, 'node_modules/electron/dist/electron');

interface ILaunched {
  app: ElectronApplication;
  page: Page;
  origin: string;
}

let root: string;

test.beforeEach(async () => {
  root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-desktop-e2e-'));
});

test.afterEach(async () => {
  // Electron helpers of a killed app can still write for a moment.
  for (let attempt = 0; attempt < 5; attempt++) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await new Promise(resolve => setTimeout(resolve, 300));
    if (!(await fs.stat(root).catch(() => null))) {
      return;
    }
  }
});

/**
 * Starts the staged app with simulated daemons and a profile and config of its
 * own. The development Electron binary has no setuid sandbox helper, so these
 * flows pass --no-sandbox for hosts that restrict user namespaces.
 */
function environment() {
  return {
    ...process.env,
    PM2_CAPTAIN_DESKTOP_FAKE: 'basic',
    PM2_CAPTAIN_DESKTOP_PROFILE_DIR: libPath.join(root, 'profile'),
    XDG_CONFIG_HOME: libPath.join(root, 'config'),
    HOME: libPath.join(root, 'home'),
  } as Record<string, string>;
}

async function launch(): Promise<ILaunched> {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: ['--no-sandbox', appDir],
    env: environment(),
  });
  const page = await app.firstWindow();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 30_000 });
  await expect(page.getByText('api', { exact: true }).first()).toBeVisible();
  return { app, page, origin: new URL(page.url()).origin };
}

/** The processes under a main process, with their arguments. */
function descendants(mainPid: number) {
  const output = execFileSync('ps', ['-eo', 'pid=,ppid=,args=']).toString();
  const rows = output
    .trim()
    .split('\n')
    .map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
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
  return rows.filter(row => row.pid !== mainPid && descendants.has(row.pid));
}

/** PIDs of the backend utility processes under a main process. */
function backendPids(mainPid: number): number[] {
  return descendants(mainPid)
    .filter(row => row.args.includes('--utility-sub-type=node.mojom.NodeService'))
    .map(row => row.pid);
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('shows the bundled backend in a locked-down window', async () => {
  const { app, page, origin } = await launch();

  // The session cookie was set by main; the token never was in a URL.
  expect(page.url()).toBe(`${origin}/`);
  const cookies = await app.evaluate(async ({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    return window.webContents.session.cookies.get({});
  });
  expect(cookies).toEqual([
    expect.objectContaining({ name: 'pm2_captain_session', httpOnly: true, sameSite: 'strict' }),
  ]);
  const defaultSessionCookies = await app.evaluate(({ session }) =>
    session.defaultSession.cookies.get({})
  );
  expect(defaultSessionCookies).toEqual([]);
  const history = await page.evaluate(() => document.cookie);
  expect(history).toBe('');

  // The page has the narrow bridge and nothing of Node or Electron.
  expect(
    await page.evaluate(() => ({
      bridge: Object.keys(
        (window as unknown as { pm2CaptainDesktop?: object }).pm2CaptainDesktop ?? {}
      ),
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
    }))
  ).toEqual({ bridge: ['preferences', 'updates'], require: 'undefined', process: 'undefined' });

  // Leaving the backend's origin is blocked and handed to the system browser,
  // which is recorded here instead of started.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { openedLinks: string[] }).openedLinks = opened;
    shell.openExternal = async (url: string) => void opened.push(url);
  });
  await page.evaluate(() => {
    window.location.href = 'https://example.com/';
  });
  await page.waitForTimeout(500);
  expect(new URL(page.url()).origin).toBe(origin);
  expect(
    await app.evaluate(() => (globalThis as unknown as { openedLinks: string[] }).openedLinks)
  ).toEqual(['https://example.com/']);
  await page.evaluate(() => window.open('http://127.0.0.1:1/'));
  await page.waitForTimeout(300);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

  await app.close();
});

test('refuses the bridge to pages that are not the current Captain page', async () => {
  const { app } = await launch();
  const preloadPath = libPath.join(appDir, 'dist/desktop/preload.js');

  const result = await app.evaluate(async ({ BrowserWindow }, preload) => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true },
    });
    await window.loadURL('data:text/html,<title>other</title>');
    const outcome = await window.webContents.executeJavaScript(`Promise.all([
      window.pm2CaptainDesktop.preferences.load().then(() => "allowed", () => "refused"),
      window.pm2CaptainDesktop.updates.skip("9.9.9").then(() => "allowed", () => "refused")
    ])`);
    window.destroy();
    return outcome;
  }, preloadPath);

  expect(result).toEqual(['refused', 'refused']);
  await app.close();
});

test('keeps UI preferences although the port changes on every launch', async () => {
  const first = await launch();
  await first.page.getByText('api', { exact: true }).first().click();
  await first.page.getByRole('link', { name: 'Env' }).click();
  await expect(first.page).toHaveURL(/\/env$/);
  await first.app.close();

  const second = await launch();
  expect(second.origin).not.toBe(first.origin);
  await second.page.getByText('worker', { exact: true }).first().click();
  // The remembered tab is used for the next process opened.
  await expect(second.page).toHaveURL(/\/env$/);
  const saved = JSON.parse(
    await fs.readFile(libPath.join(root, 'profile/preferences.json'), 'utf8')
  );
  expect(saved.ui['pm2-captain-process-tab']).toBe('env');
  await second.app.close();
});

test('saves filtered logs through a download', async () => {
  const { app, page } = await launch();
  const target = libPath.join(root, 'saved.log');
  // Stands in for the save dialog: the first listener to choose a path wins.
  await app.evaluate(({ BrowserWindow }, savePath) => {
    const [window] = BrowserWindow.getAllWindows();
    window.webContents.session.prependListener('will-download', (_event, item) =>
      item.setSavePath(savePath)
    );
  }, target);
  await page.getByText('api', { exact: true }).first().click();
  await page.getByRole('link', { name: 'Logs' }).click();
  await expect(page.getByTitle('Loaded lines')).not.toHaveText('0');

  await page.getByRole('button', { name: 'Download filtered logs' }).click();

  await expect
    .poll(async () => (await fs.stat(target).catch(() => null))?.size ?? 0)
    .toBeGreaterThan(0);
  expect(await fs.readFile(target, 'utf8')).toMatch(/\[(OUT|ERR)\]/);
  await app.close();
});

test('stops its backend on quit and restarts one that crashes', async () => {
  const { app, origin } = await launch();
  const mainPid = app.process().pid!;
  const [backend] = backendPids(mainPid);
  expect(backend).toEqual(expect.any(Number));

  // A crashed backend is replaced with a new one, on a new port and in a new
  // window and session; the old window shows a status page until then.
  process.kill(backend, 'SIGKILL');
  const findReplacement = () =>
    app
      .windows()
      .find(
        candidate =>
          !candidate.isClosed() &&
          /^http:\/\/127\.0\.0\.1:\d+\//.test(candidate.url()) &&
          new URL(candidate.url()).origin !== origin
      );
  await expect.poll(() => findReplacement() !== undefined, { timeout: 30_000 }).toBe(true);
  const restarted = findReplacement()!;
  await expect(restarted.getByText('api', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  expect(app.windows().filter(candidate => !candidate.isClosed())).toHaveLength(1);
  const [replacement] = backendPids(mainPid);
  expect(replacement).not.toBe(backend);

  await app.close();
  await expect.poll(() => isAlive(replacement), { timeout: 15_000 }).toBe(false);
});

test('ends its backend when the app process is killed', async () => {
  const { app } = await launch();
  const mainPid = app.process().pid!;
  const [backend] = backendPids(mainPid);

  process.kill(mainPid, 'SIGKILL');

  await expect.poll(() => isAlive(backend), { timeout: 15_000 }).toBe(false);
});

test('opens one window per profile', async () => {
  const { app } = await launch();

  const second = spawn(electronPath, ['--no-sandbox', appDir], {
    env: environment(),
    stdio: 'ignore',
  });
  const code = await new Promise<number | null>(resolve => second.once('exit', resolve));

  expect(code).toBe(0);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await app.close();
});

/** Runs `pm2-captain fake --control <file> …` against the app, as the desktop guide shows. */
async function fakeCommand(...args: string[]) {
  const controlFile = libPath.join(root, 'profile', 'fake-control.json');
  await expect
    .poll(() =>
      fs.access(controlFile).then(
        () => true,
        () => false
      )
    )
    .toBe(true);
  const { stdout } = await promisify(execFile)(process.execPath, [
    libPath.join(rootDir, 'dist/backend/app.js'),
    'fake',
    '--control',
    controlFile,
    ...args,
  ]);
  return stdout.trim();
}

test('shows the simulated update in a toast and menu, and keeps installing it simulated', async () => {
  const { app, origin } = await launch();
  const updateToast = (page: Page) => page.locator('[data-component="UpdateToast"]');
  const updateMenuLabel = () =>
    app.evaluate(({ Menu }) => {
      const labels: string[] = [];
      const visit = (items: Electron.MenuItem[]) =>
        items.forEach(item => {
          labels.push(item.label);
          if (item.submenu) {
            visit(item.submenu.items);
          }
        });
      visit(Menu.getApplicationMenu()?.items ?? []);
      return labels.find(label => /Update/.test(label)) ?? null;
    });

  expect(await fakeCommand('update.set', 'status=downloaded', 'version=9.9.9')).toBe('OK');
  const page = app.windows().find(candidate => candidate.url().startsWith(origin))!;
  await expect(updateToast(page)).toContainText('PM2 Captain 9.9.9 is ready to install.');
  await expect.poll(updateMenuLabel).toBe('Restart to Update to 9.9.9');

  // The install goes to the simulation through main and the backend; the app keeps running.
  await updateToast(page).getByRole('button', { name: 'Restart to update' }).click();
  await expect(updateToast(page)).toContainText('The simulated installation failed.');
  expect(app.process().exitCode).toBeNull();
  expect(JSON.parse(await fakeCommand('state')).update).toMatchObject({
    status: 'downloaded',
    error: { phase: 'install' },
  });

  expect(await fakeCommand('update.reset')).toBe('OK');
  await expect(updateToast(page)).toHaveCount(0);
  await expect.poll(updateMenuLabel).toBe('Check for Updates…');

  // A new backend after a crash has a new world, and the app follows it.
  const controlFile = libPath.join(root, 'profile', 'fake-control.json');
  const before = await fs.readFile(controlFile, 'utf8');
  const [backend] = backendPids(app.process().pid!);
  process.kill(backend, 'SIGKILL');
  await expect
    .poll(
      () =>
        app
          .windows()
          .some(candidate => /^http:/.test(candidate.url()) && !candidate.url().startsWith(origin)),
      {
        timeout: 30_000,
      }
    )
    .toBe(true);
  // The new backend writes its own address and token.
  await expect
    .poll(() => fs.readFile(controlFile, 'utf8').catch(() => before), { timeout: 30_000 })
    .not.toBe(before);
  expect(await fakeCommand('update.set', 'status=downloaded', 'version=9.9.10')).toBe('OK');
  const restarted = app
    .windows()
    .find(candidate => /^http:/.test(candidate.url()) && !candidate.url().startsWith(origin))!;
  await expect(updateToast(restarted)).toContainText('PM2 Captain 9.9.10 is ready to install.');

  await app.close();
  // The control file goes away with the backend.
  await expect
    .poll(() =>
      fs.access(libPath.join(root, 'profile', 'fake-control.json')).then(
        () => true,
        () => false
      )
    )
    .toBe(false);
});

test('remembers a skipped update across launches and restores it from Check for Updates', async ({}, testInfo) => {
  const first = await launch();
  const firstToast = first.page.locator('[data-component="UpdateToast"]');
  expect(await fakeCommand('update.set', 'status=downloaded', 'version=9.9.9')).toBe('OK');
  await expect(firstToast).toContainText('PM2 Captain 9.9.9 is ready to install.');
  await first.page.locator('[data-sonner-toast]').screenshot({
    path: testInfo.outputPath('update-toast.png'),
  });
  await firstToast.getByRole('button', { name: 'Skip this version' }).click();
  await expect(firstToast).toHaveCount(0);
  await first.app.close();

  const saved = JSON.parse(
    await fs.readFile(libPath.join(root, 'profile/preferences.json'), 'utf8')
  );
  expect(saved.ui['pm2-captain-skipped-update-version']).toBe('9.9.9');
  const second = await launch();
  const secondToast = second.page.locator('[data-component="UpdateToast"]');
  expect(await fakeCommand('update.set', 'status=downloaded', 'version=9.9.9')).toBe('OK');
  await second.page.reload();
  await expect(second.page.getByText('api', { exact: true }).first()).toBeVisible();
  await expect(secondToast).toHaveCount(0);

  const didCheck = await second.app.evaluate(({ Menu }) => {
    const clickCheck = (items: Electron.MenuItem[]): boolean => {
      for (const item of items) {
        if (item.label === 'Check for Updates…' && item.enabled) {
          item.click();
          return true;
        }
        if (item.submenu && clickCheck(item.submenu.items)) {
          return true;
        }
      }
      return false;
    };
    return clickCheck(Menu.getApplicationMenu()?.items ?? []);
  });
  expect(didCheck).toBe(true);
  await expect(secondToast).toContainText('PM2 Captain 9.9.9 is ready to install.');
  await secondToast.getByRole('button', { name: 'Skip this version' }).click();
  await expect(secondToast).toHaveCount(0);
  expect(await fakeCommand('update.set', 'status=downloaded', 'version=9.9.10')).toBe('OK');
  await expect(secondToast).toContainText('PM2 Captain 9.9.10 is ready to install.');
  await second.app.close();
});

/**
 * Records the app's quit and window events, in order, into a file that
 * survives the app.
 */
async function recordLifecycle(app: ElectronApplication) {
  const file = libPath.join(root, 'lifecycle.log');
  await app.evaluate(({ app: electronApp }, path) => {
    const { appendFileSync } = process.getBuiltinModule('node:fs');
    electronApp.on('before-quit', () => appendFileSync(path, 'before-quit\n'));
    electronApp.on('browser-window-created', () => appendFileSync(path, 'window\n'));
  }, file);
  return async () => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean);
}

const mainLog = () =>
  fs.readFile(libPath.join(root, 'profile', 'logs', 'main.log'), 'utf8').catch(() => '');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`quits in order on ${signal}, stopping its backend first`, async () => {
    const { app } = await launch();
    const mainPid = app.process().pid!;
    const controlFile = libPath.join(root, 'profile', 'fake-control.json');
    await expect
      .poll(() =>
        fs.access(controlFile).then(
          () => true,
          () => false
        )
      )
      .toBe(true);
    const lifecycle = await recordLifecycle(app);
    const children = descendants(mainPid).map(row => row.pid);
    const exited = new Promise(resolve => app.process().once('exit', resolve));

    // Only the app's own process, as a terminal's Ctrl+C or a service manager signals it.
    process.kill(mainPid, signal);

    expect(await exited).toBe(0);
    expect((await lifecycle())[0]).toBe('before-quit');
    expect(await mainLog()).toContain('Backend exited {"code":0}');
    await expect.poll(() => children.filter(isAlive), { timeout: 15_000 }).toEqual([]);
    await expect(fs.access(controlFile)).rejects.toThrow();
  });
}

test('quits without opening a window when a signal comes during startup', async () => {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: ['--no-sandbox', appDir],
    env: environment(),
  });
  const mainPid = app.process().pid!;
  const lifecycle = await recordLifecycle(app);
  await expect.poll(mainLog, { intervals: [10] }).toContain('Starting');
  const children = descendants(mainPid).map(row => row.pid);
  const exited = new Promise(resolve => app.process().once('exit', resolve));

  // While the backend is still starting.
  process.kill(mainPid, 'SIGINT');

  expect(await exited).toBe(0);
  const events = await lifecycle();
  const log = await mainLog();
  expect(events[0]).toBe('before-quit');
  expect(events).not.toContain('window');
  expect(log).not.toContain('The window could not load the backend');
  expect(log).not.toContain('could not start');
  const remaining = () => [...children, ...backendPids(mainPid)].filter(isAlive);
  await expect.poll(remaining, { timeout: 15_000 }).toEqual([]);
  await expect(fs.access(libPath.join(root, 'profile', 'fake-control.json'))).rejects.toThrow();
});
