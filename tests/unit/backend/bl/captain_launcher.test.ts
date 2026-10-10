import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCaptainLauncher,
  resolveBrowserOpenCommand,
} from '../../../../src/backend/bl/captain_launcher';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ once: vi.fn(), unref: vi.fn() })),
}));

const url = 'http://127.0.0.1:3212';

describe('browser link support', () => {
  it('uses xdg-open when a Linux desktop and executable are available', () => {
    const resolveExecutable = vi.fn(() => '/usr/bin/xdg-open');

    expect(
      resolveBrowserOpenCommand(
        url,
        'linux',
        { DISPLAY: ':0', PATH: '/usr/bin' },
        resolveExecutable
      )
    ).toEqual(['/usr/bin/xdg-open', [url]]);
  });

  it('does not claim browser support in a headless Linux environment', () => {
    const resolveExecutable = vi.fn(() => '/usr/bin/xdg-open');

    expect(
      resolveBrowserOpenCommand(url, 'linux', { PATH: '/usr/bin' }, resolveExecutable)
    ).toBeNull();
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it('does not claim browser support when xdg-open is unavailable', () => {
    expect(
      resolveBrowserOpenCommand(url, 'linux', { DISPLAY: ':0', PATH: '/usr/bin' }, () => null)
    ).toBeNull();
  });

  it('detects the native macOS opener', () => {
    expect(
      resolveBrowserOpenCommand(url, 'darwin', { PATH: '/usr/bin' }, () => '/usr/bin/open')
    ).toEqual(['/usr/bin/open', [url]]);
  });
});

describe('launch token', () => {
  it('lives in a private config directory and survives restarts', async () => {
    const root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2-captain-launcher-'));
    const configDir = libPath.join(root, 'config', 'pm2-captain');
    const launch = async () => {
      const launcher = createCaptainLauncher({
        settings: { configDir, noAuth: false },
        log: { warn: vi.fn() },
      } as never);
      await launcher.initialize();
      return launcher;
    };
    try {
      const launcher = await launch();
      const tokenPath = libPath.join(configDir, 'launch-token');
      const token = (await fs.readFile(tokenPath, 'utf8')).trim();

      expect(token).toMatch(/^[\w-]{43}$/);
      expect((await fs.stat(configDir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(tokenPath)).mode & 0o777).toBe(0o600);
      expect(launcher.authenticate(token)).toBe(true);
      expect(launcher.authenticate(`${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`)).toBe(false);
      expect(launcher.authenticate(undefined)).toBe(false);
      expect((await launch()).authenticate(token)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('browser tab reuse', () => {
  const now = new Date('2026-01-01T12:00:00Z').getTime();
  const waitFor = async () => {};
  let root: string;
  let configDir: string;

  const createLauncher = (browserOpen = 'auto', port = 3212) =>
    createCaptainLauncher({
      settings: { configDir, port, baseURL: url, noAuth: true, browserOpen },
      log: { warn: vi.fn() },
    } as never);

  /** Runs a Captain that had a tab connected when it stopped. */
  const stopWithTab = async (port = 3212) => {
    const launcher = createLauncher('auto', port);
    launcher.trackTab();
    await launcher.stop();
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2-captain-launcher-'));
    configDir = libPath.join(root, 'config');
    // Any platform's opener resolves to this stub, so no real browser starts.
    const binDir = libPath.join(root, 'bin');
    await fs.mkdir(binDir);
    for (const name of ['xdg-open', 'open', 'cmd.exe']) {
      await fs.writeFile(libPath.join(binDir, name), '', { mode: 0o755 });
    }
    vi.stubEnv('PATH', binDir);
    vi.stubEnv('DISPLAY', ':0');
    vi.stubEnv('ComSpec', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now });
    vi.mocked(spawn).mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('opens a tab at once when no tab was connected before', async () => {
    await createLauncher().start(waitFor);

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('keeps the record private', async () => {
    await stopWithTab();

    expect((await fs.stat(libPath.join(configDir, 'tab-seen-3212'))).mode & 0o777).toBe(0o600);
  });

  it('opens nothing when the previous tab reconnects', async () => {
    await stopWithTab();
    vi.setSystemTime(now + 2_000);
    const launcher = createLauncher();
    await launcher.start(waitFor);
    const releaseTab = launcher.trackTab();
    // A tab that dropped again still proves the browser has one open.
    releaseTab();
    vi.advanceTimersByTime(60_000);

    expect(spawn).not.toHaveBeenCalled();
  });

  it('opens a tab when the previous one does not reconnect in time', async () => {
    await stopWithTab();
    const launcher = createLauncher();
    await launcher.start(waitFor);

    expect(spawn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(6_000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('opens a tab at once after a long downtime', async () => {
    await stopWithTab();
    vi.setSystemTime(now + 60_000);
    await createLauncher().start(waitFor);

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('remembers a tab that closed shortly before the stop', async () => {
    const previous = createLauncher();
    previous.trackTab()();
    vi.setSystemTime(now + 10_000);
    await previous.stop();
    await createLauncher().start(waitFor);

    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps the record across a run too short for the tab to reconnect', async () => {
    await stopWithTab();
    const shortRun = createLauncher();
    await shortRun.start(waitFor);
    await shortRun.stop();
    vi.advanceTimersByTime(60_000);
    expect(spawn).not.toHaveBeenCalled();

    vi.setSystemTime(now + 5_000);
    await createLauncher().start(waitFor);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['', 'garbage', String(now + 3_600_000)])(
    'opens a tab at once when the record is %j',
    async content => {
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(libPath.join(configDir, 'tab-seen-3212'), content);
      await createLauncher().start(waitFor);

      expect(spawn).toHaveBeenCalledTimes(1);
    }
  );

  it('ignores a tab that belonged to a Captain on another port', async () => {
    await stopWithTab(3213);
    await createLauncher().start(waitFor);

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('always opens a tab with --open', async () => {
    await stopWithTab();
    await createLauncher('always').start(waitFor);

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('never opens a tab with --no-open', async () => {
    await createLauncher('never').start(waitFor);
    vi.advanceTimersByTime(60_000);

    expect(spawn).not.toHaveBeenCalled();
  });
});
