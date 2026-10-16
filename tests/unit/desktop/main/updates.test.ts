import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => '1.5.0', isInApplicationsFolder: () => true },
}));
vi.mock('electron', () => electron);
vi.mock('electron-updater', () => ({ autoUpdater: {} }));

const { createUpdateController, detectInstallKind, selectUpdateMode, testFeedURL } =
  await import('../../../../src/desktop/main/updates');

class FakeUpdater extends EventEmitter {
  logger: unknown = null;
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  autoRunAppAfterInstall = false;
  forceDevUpdateConfig = false;
  checkForUpdates = vi.fn(async () => null);
  quitAndInstall = vi.fn();
  setFeedURL = vi.fn();
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function setup(
  installKind: 'deb' | 'rpm' | 'appimage' | 'mac' | null,
  installerOverrides = {},
  environment: NodeJS.ProcessEnv = {}
) {
  const updater = new FakeUpdater();
  const hooks = {
    prepareForInstall: vi.fn(async () => undefined),
    restoreAfterInstallNotStarted: vi.fn(async () => undefined),
    allowQuitForUpdate: vi.fn(),
    relaunchAfterInstall: vi.fn(),
    showInstallRecovery: vi.fn(),
  };
  const linuxInstaller = {
    verify: vi.fn(async () => undefined),
    install: vi.fn(async () => ({ kind: 'installed' as const })),
    readMarker: vi.fn(() => null),
    logPath: '/profile/update-install.log',
    ...installerOverrides,
  };
  const controller = createUpdateController({
    log,
    hooks,
    linuxInstaller: linuxInstaller as never,
    updater: updater as never,
    installKind,
    feedURL: null,
    environment,
  });
  return { controller, updater, hooks, linuxInstaller };
}

const downloaded = (extension: string) => ({
  version: '1.6.0',
  downloadedFile: `/cache/pending/update.${extension}`,
  files: [
    { url: 'PM2-Captain-x86_64.AppImage', sha512: 'appimage-sha' },
    { url: 'pm2-captain-desktop_1.6.0_amd64.deb', sha512: 'deb-sha' },
    { url: 'pm2-captain-desktop-1.6.0.x86_64.rpm', sha512: 'rpm-sha' },
  ],
});

beforeEach(() => {
  electron.app.isPackaged = true;
});

describe('update controller', () => {
  it('downloads in the background but never installs on quit, prereleases or downgrades', () => {
    const { updater, controller } = setup('deb');

    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(controller.state).toMatchObject({ status: 'idle', requiresAuthorization: true });
  });

  it('is off in development builds and installations that cannot update', () => {
    electron.app.isPackaged = false;
    expect(setup('deb').controller.state.status).toBe('disabled');
    electron.app.isPackaged = true;
    expect(setup(null).controller.state).toMatchObject({ status: 'disabled' });
  });

  it('follows a check and download, and keeps a failed check recoverable', async () => {
    const { updater, controller } = setup('appimage');

    updater.emit('checking-for-update');
    expect(controller.state.status).toBe('checking');
    updater.emit('error', new Error('offline'));
    expect(controller.state).toMatchObject({ status: 'error', error: { phase: 'check' } });
    updater.emit('update-available', { version: '1.6.0' });
    updater.emit('download-progress', { percent: 41.6 });
    expect(controller.state).toMatchObject({ status: 'downloading', percent: 42 });
    updater.emit('error', new Error('connection reset'));
    expect(controller.state.error).toMatchObject({ phase: 'download' });
    updater.emit('update-downloaded', downloaded('AppImage'));
    expect(controller.state).toMatchObject({ status: 'downloaded', version: '1.6.0', error: null });
  });

  it('installs a DEB only after checking it, then starts the new version', async () => {
    const { updater, controller, hooks, linuxInstaller } = setup('deb');
    updater.emit('update-downloaded', downloaded('deb'));

    await controller.install();

    expect(linuxInstaller.verify).toHaveBeenCalledWith({
      packageType: 'deb',
      file: '/cache/pending/update.deb',
      version: '1.6.0',
      sha512: 'deb-sha',
    });
    expect(hooks.prepareForInstall).toHaveBeenCalled();
    expect(hooks.relaunchAfterInstall).toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('picks the RPM from a manifest that also lists a DEB and an AppImage', async () => {
    const { updater, controller, linuxInstaller } = setup('rpm');
    updater.emit('update-downloaded', downloaded('rpm'));

    await controller.install();

    expect(linuxInstaller.verify).toHaveBeenCalledWith(
      expect.objectContaining({ packageType: 'rpm', sha512: 'rpm-sha' })
    );
  });

  it('keeps the app running when the package fails its checks', async () => {
    const { updater, controller, hooks } = setup('deb', {
      verify: vi.fn(async () => {
        const { InstallPreconditionError } =
          await import('../../../../src/desktop/main/linux_installer');
        throw new InstallPreconditionError('The downloaded update does not match its checksum.');
      }),
    });
    updater.emit('update-downloaded', downloaded('deb'));

    await controller.install();

    expect(hooks.prepareForInstall).not.toHaveBeenCalled();
    expect(controller.state).toMatchObject({
      status: 'downloaded',
      error: { phase: 'install', message: 'The downloaded update does not match its checksum.' },
    });
  });

  it('restores the backend when authorization is cancelled', async () => {
    const { updater, controller, hooks } = setup('deb', {
      install: vi.fn(async () => ({ kind: 'not-started' as const, message: 'cancelled' })),
    });
    updater.emit('update-downloaded', downloaded('deb'));

    await controller.install();

    expect(hooks.restoreAfterInstallNotStarted).toHaveBeenCalled();
    expect(hooks.showInstallRecovery).not.toHaveBeenCalled();
    expect(controller.state).toMatchObject({
      status: 'downloaded',
      error: { message: 'cancelled' },
    });
  });

  it('shows recovery and keeps the backend stopped after a failed installation', async () => {
    const { updater, controller, hooks } = setup('rpm', {
      install: vi.fn(async () => ({
        kind: 'uncertain' as const,
        message: 'failed',
        logPath: '/log',
      })),
    });
    updater.emit('update-downloaded', downloaded('rpm'));

    await controller.install();

    expect(hooks.showInstallRecovery).toHaveBeenCalledWith('failed');
    expect(hooks.restoreAfterInstallNotStarted).not.toHaveBeenCalled();
    expect(hooks.relaunchAfterInstall).not.toHaveBeenCalled();
  });

  it('decides by the marker when the installation throws', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('EIO');
    });
    const withoutMarker = setup('deb', { install: throwing });
    withoutMarker.updater.emit('update-downloaded', downloaded('deb'));
    await withoutMarker.controller.install();
    expect(withoutMarker.hooks.restoreAfterInstallNotStarted).toHaveBeenCalled();

    const withMarker = setup('deb', { install: throwing, readMarker: vi.fn(() => ({})) });
    withMarker.updater.emit('update-downloaded', downloaded('deb'));
    await withMarker.controller.install();
    expect(withMarker.hooks.showInstallRecovery).toHaveBeenCalled();
    expect(withMarker.hooks.restoreAfterInstallNotStarted).not.toHaveBeenCalled();
  });

  it('replaces an AppImage itself, never through the library installer', async () => {
    const directory = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-appimage-update-'));
    try {
      const appImagePath = libPath.join(directory, 'PM2-Captain-x86_64.AppImage');
      const downloadedFile = libPath.join(directory, 'download.AppImage');
      await fs.writeFile(appImagePath, 'old version');
      await fs.writeFile(downloadedFile, 'new version');
      const sha512 = createHash('sha512').update('new version').digest('base64');
      const { updater, controller, hooks } = setup('appimage', {}, { APPIMAGE: appImagePath });
      updater.emit('update-downloaded', {
        version: '1.6.0',
        downloadedFile,
        files: [{ url: 'PM2-Captain-x86_64.AppImage', sha512 }],
      });

      await controller.install();

      expect(updater.quitAndInstall).not.toHaveBeenCalled();
      expect(await fs.readFile(appImagePath, 'utf8')).toBe('new version');
      expect(hooks.relaunchAfterInstall).toHaveBeenCalledWith({ execPath: appImagePath });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the old AppImage and restores the backend when it cannot be replaced', async () => {
    const { updater, controller, hooks } = setup(
      'appimage',
      {},
      {
        APPIMAGE: '/nonexistent/PM2-Captain-x86_64.AppImage',
      }
    );
    updater.emit('update-downloaded', downloaded('AppImage'));

    await controller.install();

    expect(hooks.restoreAfterInstallNotStarted).toHaveBeenCalled();
    expect(controller.state).toMatchObject({ status: 'downloaded', error: { phase: 'install' } });
  });

  it('restores the backend when the macOS library refuses to install', async () => {
    const { updater, controller, hooks } = setup('mac');
    updater.emit('update-downloaded', downloaded('zip'));

    await controller.install();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    updater.emit('error', new Error('code signature mismatch'));

    expect(hooks.restoreAfterInstallNotStarted).toHaveBeenCalled();
  });

  it('never restarts the backend while a package installation runs', async () => {
    let finish!: (outcome: { kind: 'installed' }) => void;
    const { updater, controller, hooks, linuxInstaller } = setup('deb', {
      install: vi.fn(() => new Promise(resolve => (finish = resolve))),
    });
    updater.emit('update-downloaded', downloaded('deb'));

    const installing = controller.install();
    await vi.waitFor(() => expect(linuxInstaller.install).toHaveBeenCalled());
    // Background events while the package manager may be replacing files.
    updater.emit('error', new Error('network down'));
    updater.emit('update-downloaded', { ...downloaded('deb'), version: '1.7.0' });
    await controller.check();
    await controller.install();

    expect(hooks.restoreAfterInstallNotStarted).not.toHaveBeenCalled();
    expect(linuxInstaller.install).toHaveBeenCalledOnce();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(controller.state.status).toBe('installing');
    finish({ kind: 'installed' });
    await installing;
    expect(hooks.relaunchAfterInstall).toHaveBeenCalledOnce();
  });

  it('runs scheduled checks through the same guard', async () => {
    vi.useFakeTimers();
    try {
      const { updater, controller } = setup('deb', {
        install: vi.fn(() => new Promise(() => undefined)),
      });
      controller.start();
      updater.emit('update-downloaded', downloaded('deb'));
      void controller.install();
      await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);

      expect(updater.checkForUpdates).not.toHaveBeenCalled();
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing until an update is downloaded', async () => {
    const { controller, hooks, updater } = setup('mac');

    await controller.install();

    expect(hooks.prepareForInstall).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe('installation kind', () => {
  it('reads package-type, which a DEB or RPM build carries and an AppImage does not', async () => {
    const resources = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-resources-'));
    try {
      expect(detectInstallKind('linux', resources, {})).toBeNull();
      expect(
        detectInstallKind('linux', resources, { APPIMAGE: '/apps/PM2-Captain-x86_64.AppImage' })
      ).toBe('appimage');
      await fs.writeFile(libPath.join(resources, 'package-type'), 'rpm\n');
      expect(detectInstallKind('linux', resources, { APPIMAGE: '/x.AppImage' })).toBe('rpm');
      await fs.writeFile(libPath.join(resources, 'package-type'), 'pacman');
      expect(detectInstallKind('linux', resources, {})).toBeNull();
      expect(detectInstallKind('darwin', resources, {})).toBe('mac');
    } finally {
      await fs.rm(resources, { recursive: true, force: true });
    }
  });

  it('only accepts a loopback HTTP test feed', () => {
    const feed = (value: string) => testFeedURL({ PM2_CAPTAIN_DESKTOP_UPDATE_TEST_FEED: value });
    expect(feed('http://127.0.0.1:8899/feed/')).toBe('http://127.0.0.1:8899/feed/');
    expect(feed('https://example.com/feed')).toBeNull();
    expect(feed('http://localhost.evil.com/')).toBeNull();
    expect(testFeedURL({})).toBeNull();
  });

  it('simulates updates in fake mode, unless a usable test feed asks for real ones', () => {
    expect(selectUpdateMode({})).toBe('real');
    expect(selectUpdateMode({ PM2_CAPTAIN_DESKTOP_FAKE: 'basic' })).toBe('simulated');
    // The release workflow's installed-update test: simulated daemons, real updates.
    expect(
      selectUpdateMode({
        PM2_CAPTAIN_DESKTOP_FAKE: 'basic',
        PM2_CAPTAIN_DESKTOP_UPDATE_TEST_FEED: 'http://127.0.0.1:8732/',
      })
    ).toBe('real');
    for (const feed of ['https://example.com/', 'http://localhost:8732/', 'not a url', '']) {
      expect(
        selectUpdateMode({
          PM2_CAPTAIN_DESKTOP_FAKE: 'basic',
          PM2_CAPTAIN_DESKTOP_UPDATE_TEST_FEED: feed,
        })
      ).toBe('simulated');
    }
  });
});
