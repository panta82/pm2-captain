import { app } from 'electron';
import { type AppUpdater, type UpdateDownloadedEvent, autoUpdater } from 'electron-updater';
import { readFileSync } from 'node:fs';
import libPath from 'node:path';

import type { IDesktopInstallKind, IDesktopUpdateState } from '../../shared/desktop_bridge';
import { installAppImage } from './appimage_installer';
import type { IFileLog } from './desktop_log';
import { ILinuxInstaller, InstallPreconditionError } from './linux_installer';

const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What the window, menu and IPC use, whether updates are real or simulated. */
export interface IUpdateController {
  readonly state: IDesktopUpdateState;
  onState(listener: (state: IDesktopUpdateState) => void): () => void;
  start(): void;
  stop(): void;
  check(): Promise<void>;
  install(): Promise<void>;
}

/**
 * Fake mode simulates updates, so nothing is downloaded or installed. The one
 * exception is the release workflow's update test, which runs simulated
 * daemons against a real loopback update feed to update the installed app for
 * real; an absent or unusable feed keeps fake mode simulated.
 */
export function selectUpdateMode(environment: NodeJS.ProcessEnv = process.env) {
  return environment.PM2_CAPTAIN_DESKTOP_FAKE && !testFeedURL(environment)
    ? ('simulated' as const)
    : ('real' as const);
}

/** What the rest of the app does around an installation. */
export interface IUpdateHooks {
  /** Flushes state and stops the backend before the app is replaced. */
  prepareForInstall(): Promise<void>;
  /** Brings the backend back after an installation that never started. */
  restoreAfterInstallNotStarted(): Promise<void>;
  /** Lets the library quit the app for a macOS installation. */
  allowQuitForUpdate(): void;
  /** Starts the new version once it is installed; an AppImage gives its new file. */
  relaunchAfterInstall(options?: { execPath: string }): void | Promise<void>;
  /** The installation may be partial; the backend stays stopped. */
  showInstallRecovery(message: string): void;
}

/**
 * How this copy of the app was installed. The `package-type` resource is what
 * electron-builder writes into DEB and RPM builds, and what electron-updater
 * reads to choose its updater; an AppImage has none and sets APPIMAGE.
 */
export function detectInstallKind(
  platform: NodeJS.Platform = process.platform,
  resourcesPath: string = process.resourcesPath,
  environment: NodeJS.ProcessEnv = process.env
): IDesktopInstallKind | null {
  if (platform === 'darwin') {
    return 'mac';
  }
  if (platform !== 'linux') {
    return null;
  }
  try {
    const type = readFileSync(libPath.join(resourcesPath, 'package-type'), 'utf8').trim();
    if (type === 'deb' || type === 'rpm') {
      return type;
    }
  } catch {
    // Not a DEB or RPM installation.
  }
  return environment.APPIMAGE ? 'appimage' : null;
}

/**
 * A feed for update tests. Only a loopback HTTP server qualifies, so the
 * variable cannot point a normal installation at another host.
 */
export function testFeedURL(environment: NodeJS.ProcessEnv = process.env) {
  const value = environment.PM2_CAPTAIN_DESKTOP_UPDATE_TEST_FEED;
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Background checks and downloads, and an installation only when the user asks
 * for it. Stable releases only, never a downgrade, and nothing is installed on
 * an ordinary Quit.
 */
export function createUpdateController({
  log,
  hooks,
  linuxInstaller,
  updater = autoUpdater,
  installKind = detectInstallKind(),
  feedURL = testFeedURL(),
  environment = process.env,
}: {
  log: IFileLog;
  hooks: IUpdateHooks;
  linuxInstaller: ILinuxInstaller | null;
  updater?: AppUpdater;
  installKind?: IDesktopInstallKind | null;
  feedURL?: string | null;
  environment?: NodeJS.ProcessEnv;
}): IUpdateController {
  const listeners = new Set<(state: IDesktopUpdateState) => void>();
  let downloaded: UpdateDownloadedEvent | null = null;
  let timers: NodeJS.Timeout[] = [];

  const disabledReason = (() => {
    if (!installKind) {
      return app.isPackaged
        ? 'This installation cannot update itself. Download new versions from the releases page.'
        : 'Development builds do not update.';
    }
    if (!app.isPackaged && !feedURL) {
      return 'Development builds do not update.';
    }
    if (installKind === 'mac' && !app.isInApplicationsFolder()) {
      return 'Move PM2 Captain to the Applications folder to receive updates.';
    }
    return null;
  })();

  let state: IDesktopUpdateState = {
    status: disabledReason ? 'disabled' : 'idle',
    currentVersion: app.getVersion(),
    installKind,
    version: null,
    percent: null,
    disabledReason,
    error: null,
    requiresAuthorization: installKind === 'deb' || installKind === 'rpm',
  };

  const setState = (changes: Partial<IDesktopUpdateState>) => {
    state = { ...state, ...changes };
    for (const listener of listeners) {
      listener(state);
    }
  };

  /**
   * Set from the moment the user starts an installation. Only an outcome of
   * that installation clears it, never an updater event: while it is set,
   * no check runs and late download or error events cannot restart anything.
   */
  let isInstalling = false;

  /** Nothing was changed; the user can try again, and the backend comes back. */
  const finishNotStarted = async (message: string) => {
    isInstalling = false;
    setState({ status: 'downloaded', error: { phase: 'install', message } });
    await hooks.restoreAfterInstallNotStarted();
  };

  /** Checks a download before anything is stopped. Returns false after reporting why not. */
  const runPrecheck = async (precheck: () => Promise<void>) => {
    try {
      await precheck();
      return true;
    } catch (error) {
      log.warn('The downloaded update cannot be installed', { error });
      isInstalling = false;
      setState({
        status: 'downloaded',
        error: {
          phase: 'install',
          message:
            error instanceof InstallPreconditionError
              ? error.message
              : 'The update could not be checked.',
        },
      });
      return false;
    }
  };

  const installLinuxPackage = async (packageType: 'deb' | 'rpm', event: UpdateDownloadedEvent) => {
    const file = event.files.find(candidate => candidate.url.endsWith(`.${packageType}`));
    if (!linuxInstaller || !file?.sha512) {
      isInstalling = false;
      setState({
        status: 'downloaded',
        error: { phase: 'install', message: 'The update has no package for this installation.' },
      });
      return;
    }
    const request = {
      packageType,
      file: event.downloadedFile,
      version: event.version,
      sha512: file.sha512,
    };
    if (!(await runPrecheck(() => linuxInstaller.verify(request)))) {
      return;
    }
    let outcome: Awaited<ReturnType<ILinuxInstaller['install']>>;
    try {
      await hooks.prepareForInstall();
      outcome = await linuxInstaller.install(request);
    } catch (error) {
      log.error('The update installation failed unexpectedly', { error });
      // A marker means the package manager may have run.
      outcome = linuxInstaller.readMarker()
        ? {
            kind: 'uncertain',
            message: 'The update installation failed unexpectedly.',
            logPath: linuxInstaller.logPath,
          }
        : { kind: 'not-started', message: 'The update could not be installed.' };
    }
    if (outcome.kind === 'installed') {
      await hooks.relaunchAfterInstall();
    } else if (outcome.kind === 'not-started') {
      await finishNotStarted(outcome.message);
    } else {
      // The installation stays latched: nothing restarts the backend here.
      setState({ status: 'error', error: { phase: 'install', message: outcome.message } });
      hooks.showInstallRecovery(outcome.message);
    }
  };

  const installAppImageUpdate = async (event: UpdateDownloadedEvent) => {
    const file = event.files.find(candidate => candidate.url.endsWith('.AppImage'));
    const appImagePath = environment.APPIMAGE;
    if (!file?.sha512 || !appImagePath) {
      isInstalling = false;
      setState({
        status: 'downloaded',
        error: { phase: 'install', message: 'The update has no AppImage for this installation.' },
      });
      return;
    }
    try {
      await hooks.prepareForInstall();
    } catch (error) {
      log.error('Unable to prepare for the update', { error });
      await finishNotStarted('The update could not be installed.');
      return;
    }
    const outcome = await installAppImage(
      { appImagePath, file: event.downloadedFile, sha512: file.sha512 },
      log
    );
    if (outcome.kind === 'installed') {
      await hooks.relaunchAfterInstall({ execPath: appImagePath });
    } else {
      await finishNotStarted(outcome.message);
    }
  };

  updater.logger = {
    info: (message?: unknown) => log.info(`Updater: ${String(message)}`),
    warn: (message?: unknown) => log.warn(`Updater: ${String(message)}`),
    error: (message?: unknown) => log.error(`Updater: ${String(message)}`),
    debug: (message: string) => log.debug(`Updater: ${message}`),
  };
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.autoRunAppAfterInstall = true;
  if (feedURL) {
    updater.forceDevUpdateConfig = !app.isPackaged;
    updater.setFeedURL({ provider: 'generic', url: feedURL });
  }

  updater.on('checking-for-update', () => {
    if (!isInstalling) {
      setState({ status: 'checking', error: null });
    }
  });
  updater.on('update-available', info => {
    if (!isInstalling) {
      setState({ status: 'downloading', version: info.version, percent: 0 });
    }
  });
  updater.on('update-not-available', () => {
    if (!isInstalling) {
      setState({
        status: downloaded ? 'downloaded' : 'idle',
        version: downloaded?.version ?? null,
      });
    }
  });
  updater.on('download-progress', progress => {
    if (!isInstalling) {
      setState({ status: 'downloading', percent: Math.round(progress.percent) });
    }
  });
  updater.on('update-downloaded', event => {
    // The installation in progress keeps the file it checked.
    if (isInstalling) {
      return;
    }
    downloaded = event;
    log.info('Update downloaded', { version: event.version });
    setState({ status: 'downloaded', version: event.version, percent: 100, error: null });
  });
  updater.on('error', error => {
    log.warn('Update failed', { error, status: state.status });
    const message = error instanceof Error ? error.message : 'The update failed.';
    if (isInstalling) {
      // Only macOS installs through the library; its refusal leaves the app
      // unchanged. A DEB, RPM or AppImage installation reports its own outcome,
      // and an unrelated error must not restart the backend meanwhile.
      if (installKind === 'mac') {
        void finishNotStarted(message);
      }
      return;
    }
    setState({
      status: downloaded ? 'downloaded' : 'error',
      error: { phase: state.status === 'downloading' ? 'download' : 'check', message },
    });
  });

  const check = async () => {
    if (
      isInstalling ||
      state.status === 'disabled' ||
      state.status === 'checking' ||
      state.status === 'downloading'
    ) {
      return;
    }
    // Errors arrive through the error event.
    await updater.checkForUpdates().catch(() => undefined);
  };

  return {
    get state() {
      return state;
    },

    onState: (listener: (state: IDesktopUpdateState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start: () => {
      if (disabledReason) {
        log.info('Updates are disabled', { reason: disabledReason });
        return;
      }
      timers = [
        setTimeout(() => void check(), FIRST_CHECK_DELAY_MS),
        setInterval(() => void check(), CHECK_INTERVAL_MS),
      ];
    },

    stop: () => {
      timers.forEach(timer => clearTimeout(timer));
      timers = [];
    },

    check,

    /** Installs the downloaded update. Only an explicit user action calls this. */
    install: async () => {
      if (isInstalling || state.status !== 'downloaded' || !downloaded || !installKind) {
        return;
      }
      isInstalling = true;
      const event = downloaded;
      setState({ status: 'installing', error: null });
      if (installKind === 'deb' || installKind === 'rpm') {
        await installLinuxPackage(installKind, event);
        return;
      }
      if (installKind === 'appimage') {
        await installAppImageUpdate(event);
        return;
      }
      try {
        await hooks.prepareForInstall();
        hooks.allowQuitForUpdate();
        // Squirrel replaces the bundle after the app quits and starts it again.
        // A refusal arrives as an error event.
        updater.quitAndInstall(true, true);
      } catch (error) {
        log.error('The update could not be installed', { error });
        await finishNotStarted('The update could not be installed.');
      }
    },
  };
}
