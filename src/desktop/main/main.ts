// Electron main process of the PM2 Captain desktop app. It owns one bundled
// backend at a time, the window that shows it, the menu and updates. Process
// actions and logs go over the backend's HTTP API, as in a browser.
import {
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  app,
  dialog,
  ipcMain,
  shell,
  utilityProcess,
} from 'electron';
import { existsSync } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';

import { IPC_CHANNELS } from '../shared/ipc_channels';
import { launchAppImage } from './appimage_installer';
import { BackendStartError, IBackendRun, createBackendHost } from './backend_host';
import { createFileLog } from './desktop_log';
import { createBackendEnvironment } from './environment';
import { ITrustedPage, isTrustedSender } from './ipc_trust';
import { createLinuxInstaller, manualInstallCommand } from './linux_installer';
import { createMainWindow, openExternalLink, statusPageURL } from './main_window';
import { createPreferenceStore } from './preferences';
import { createSimulatedUpdateController } from './simulated_updates';
import { createUpdateNotifications } from './update_notifications';
import { createUpdateController, selectUpdateMode } from './updates';

const RELEASES_URL = 'https://github.com/panta82/pm2-captain/releases';
const ISSUES_URL = 'https://github.com/panta82/pm2-captain/issues';
/** Set for the instance that a successful update starts, so it waits for the old one to exit. */
const RELAUNCH_VARIABLE = 'PM2_CAPTAIN_RELAUNCH';
const RESTART_DELAYS_MS = [1_000, 3_000, 9_000];
const RESTART_WINDOW_MS = 2 * 60 * 1000;

// Tests and development use a profile of their own, so they never share the
// installed app's preferences or its single-instance lock.
if (process.env.PM2_CAPTAIN_DESKTOP_PROFILE_DIR) {
  app.setPath('userData', libPath.resolve(process.env.PM2_CAPTAIN_DESKTOP_PROFILE_DIR));
}
const isRelaunch = process.env[RELAUNCH_VARIABLE] === '1';
delete process.env[RELAUNCH_VARIABLE];
const fakeScenario = process.env.PM2_CAPTAIN_DESKTOP_FAKE || null;
const devBackendEntry = app.isPackaged ? null : process.env.PM2_CAPTAIN_DESKTOP_DEV_BACKEND || null;

const userData = app.getPath('userData');
const log = createFileLog(libPath.join(userData, 'logs'), 'main', !app.isPackaged);
const backendLog = createFileLog(libPath.join(userData, 'logs'), 'backend');
const preferences = createPreferenceStore(userData);
const linuxInstaller =
  process.platform === 'linux'
    ? createLinuxInstaller({ directory: userData, currentVersion: app.getVersion(), log })
    : null;

type IPhase =
  'starting' | 'running' | 'restarting' | 'failed' | 'installing' | 'recovery' | 'quitting';
let phase: IPhase = 'starting';
let mainWindow: BrowserWindow | null = null;
/** The window and origin that IPC accepts. Null while no backend page is shown. */
let trusted: ITrustedPage | null = null;
let isQuitAllowed = false;
let restartAttempts: number[] = [];

/**
 * Quitting began (before-quit), for example on Ctrl+C or SIGTERM. Startup and
 * recovery check it after each wait, so a quit that came meanwhile does not
 * get a new window, backend or dialog.
 */
const isQuitting = () => phase === 'quitting';

/** The same daemon registry as the npm command, so both show the same daemons. */
function captainConfigDir() {
  return libPath.join(
    process.env.XDG_CONFIG_HOME || libPath.join(libOs.homedir(), '.config'),
    'pm2-captain'
  );
}

function iconPath() {
  const candidates = app.isPackaged
    ? [libPath.join(process.resourcesPath, 'icon.png')]
    : // build/desktop/dev or build/desktop/app, inside the checkout.
      [libPath.join(app.getAppPath(), '../../../src/frontend/public/android-chrome-512x512.png')];
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

const backendHost = createBackendHost({
  fork: (entryPath, options) =>
    utilityProcess.fork(entryPath, [], {
      ...options,
      execArgv: devBackendEntry
        ? ['--inspect=' + (process.env.PM2_CAPTAIN_BACKEND_DEBUG_PORT || 9229)]
        : [],
      serviceName: 'PM2 Captain Backend',
      stdio: 'pipe',
    }),
  // Development runs the backend that `npm run desktop:dev` compiles into dist/.
  entryPath: devBackendEntry ?? libPath.join(__dirname, 'backend', 'desktop_backend.js'),
  environment: createBackendEnvironment(),
  backendOptions: () => ({
    configDir: captainConfigDir(),
    environmentPm2Home: process.env.PM2_HOME || null,
    fakeScenario,
    fakeControlFile: fakeScenario ? libPath.join(userData, 'fake-control.json') : null,
    // pino-pretty and Vite are development tools; a packaged app has neither.
    debug: Boolean(devBackendEntry) && process.env.DEBUG === 'true',
    serverDevMode: Boolean(devBackendEntry),
  }),
  log,
  backendLog,
  onUnexpectedExit: code => void recoverFromBackendExit(code),
  onFakeUpdate: state => simulatedUpdates?.receive(state),
});

// Fake mode simulates updates unless a test feed asks for real ones.
const simulatedUpdates =
  selectUpdateMode() === 'simulated'
    ? createSimulatedUpdateController({
        currentVersion: app.getVersion(),
        log,
        sendAction: action => backendHost.sendFakeUpdateAction(action),
      })
    : null;

const updateSource =
  simulatedUpdates ??
  createUpdateController({
    log,
    linuxInstaller,
    hooks: {
      prepareForInstall: async () => {
        phase = 'installing';
        preferences.flush();
        showStatus('Installing the update', 'PM2 Captain will start again when it is done.');
        await backendHost.stop();
      },
      restoreAfterInstallNotStarted: async () => {
        if (!app.hasSingleInstanceLock()) {
          app.requestSingleInstanceLock();
        }
        isQuitAllowed = false;
        await startBackendAndWindow();
      },
      allowQuitForUpdate: () => {
        isQuitAllowed = true;
      },
      relaunchAfterInstall: async options => {
        log.info('Update installed; starting the new version');
        // The new instance waits for this one to release the single-instance lock.
        process.env[RELAUNCH_VARIABLE] = '1';
        if (options) {
          try {
            await launchAppImage(options.execPath, process.argv.slice(1), process.env);
          } catch (error) {
            log.error('The updated AppImage could not be started', { error });
            phase = 'failed';
            showStatus('Update installed', 'Close PM2 Captain and open the AppImage again.');
            await dialog.showMessageBox({
              type: 'error',
              title: 'PM2 Captain',
              message: 'The update was installed, but PM2 Captain could not restart.',
              detail: 'Close this window and open the AppImage again to use the new version.',
              buttons: ['Quit'],
            });
            isQuitAllowed = true;
            app.quit();
            return;
          }
        } else {
          app.relaunch();
        }
        isQuitAllowed = true;
        app.exit(0);
      },
      showInstallRecovery: message => void showInstallRecovery(message),
    },
  });

const updates = createUpdateNotifications({ source: updateSource, preferences, log });

// ---------------------------------------------------------------------------
// Window and backend

function ensureWindowForStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 720,
    height: 480,
    title: 'PM2 Captain',
    backgroundColor: '#041522',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const window = mainWindow;
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  return window;
}

/** Replaces the page with a plain message. The previous session is no longer trusted. */
function showStatus(title: string, message: string) {
  trusted = null;
  void ensureWindowForStatus()
    .loadURL(statusPageURL(title, message))
    .catch(() => undefined);
}

async function openWindowFor(run: IBackendRun) {
  const previous = mainWindow;
  const created = await createMainWindow({
    run,
    preferences,
    preloadPath: libPath.join(__dirname, 'preload.js'),
    iconPath: iconPath(),
    log,
  });
  if (isQuitting()) {
    created.window.destroy();
    return;
  }
  mainWindow = created.window;
  trusted = { window: created.window, origin: created.origin };
  created.window.on('closed', () => {
    if (mainWindow === created.window) {
      mainWindow = null;
      trusted = null;
    }
  });
  if (previous && !previous.isDestroyed()) {
    previous.destroy();
  }
  try {
    await created.load();
  } catch (error) {
    // The URL holds no token, but only the code is useful here.
    log.error('The window could not load the backend', {
      code: (error as { code?: unknown }).code,
    });
  }
}

async function startBackendAndWindow(): Promise<void> {
  if (isQuitting()) {
    return;
  }
  phase = 'starting';
  let run: IBackendRun;
  try {
    run = await backendHost.start();
  } catch (error) {
    // The shutdown that quitting started stops the backend; no error to show.
    if (isQuitting()) {
      return;
    }
    phase = 'failed';
    await showStartupFailure(error);
    return;
  }
  // The shutdown stops this backend too.
  if (isQuitting()) {
    return;
  }
  phase = 'running';
  await openWindowFor(run);
}

async function showStartupFailure(error: unknown) {
  const startupError = error instanceof BackendStartError ? error.startupError : null;
  const message = startupError?.message ?? 'The backend failed to start.';
  showStatus('PM2 Captain could not start', message);
  const isRegistryError = startupError?.code === 'REGISTRY_INVALID' && startupError.path;
  const buttons = isRegistryError ? ['Retry', 'Show the File', 'Quit'] : ['Retry', 'Quit'];
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'PM2 Captain',
    message: 'PM2 Captain could not start',
    detail: isRegistryError
      ? `${message}\n\nFix the daemon list, or move it away to detect local PM2 daemons again, then choose Retry. Check for Updates stays available in the menu.`
      : `${message}\n\nThe log is in ${log.path}.`,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  });
  if (isQuitting()) {
    return;
  }
  if (buttons[response] === 'Retry') {
    await startBackendAndWindow();
  } else if (buttons[response] === 'Show the File') {
    shell.showItemInFolder(startupError!.path!);
    await showStartupFailure(error);
  } else {
    app.quit();
  }
}

/** A backend that exits by itself is restarted a few times; actions are never replayed. */
async function recoverFromBackendExit(code: number) {
  if (phase !== 'running') {
    return;
  }
  const now = Date.now();
  restartAttempts = restartAttempts.filter(time => now - time < RESTART_WINDOW_MS);
  const delay = RESTART_DELAYS_MS[restartAttempts.length];
  log.warn('The backend exited unexpectedly', { code, attempt: restartAttempts.length + 1 });
  if (delay === undefined) {
    phase = 'failed';
    await showStartupFailure(
      new BackendStartError({
        code: 'STARTUP_FAILED',
        message: `The backend keeps exiting (code ${code}).`,
        path: null,
      })
    );
    return;
  }
  restartAttempts.push(now);
  phase = 'restarting';
  showStatus('Reconnecting', 'The PM2 Captain backend stopped. Starting it again…');
  await new Promise(resolve => setTimeout(resolve, delay));
  if (phase === 'restarting') {
    await startBackendAndWindow();
  }
}

// ---------------------------------------------------------------------------
// Updates that may be incomplete

/**
 * The installation may have replaced part of the app. This process keeps its
 * backend stopped: it would load code from a tree that may be half replaced.
 * The marker stays until the user starts PM2 Captain again as a whole,
 * typically after reinstalling the package.
 */
async function showInstallRecovery(message: string, isNewLaunch = false) {
  phase = 'recovery';
  const marker = linuxInstaller?.readMarker();
  showStatus('The update may be incomplete', message);
  const tail = linuxInstaller?.readLogTail() ?? '';
  const command = marker?.file ? manualInstallCommand(marker.packageType, marker.file) : null;
  const buttons = isNewLaunch
    ? ['Show Installer Log', 'Start PM2 Captain', 'Quit']
    : ['Show Installer Log', 'Quit'];
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'PM2 Captain',
    message: 'The update may not be fully installed',
    detail: [
      message,
      'Nothing was repaired or rolled back automatically.',
      command
        ? `To repair it, install the package again in a terminal, then start PM2 Captain:\n${command}`
        : `Reinstall PM2 Captain from ${RELEASES_URL}, then start it again.`,
      isNewLaunch
        ? 'Choose Start PM2 Captain once the installation is repaired.'
        : 'PM2 Captain stays stopped until it is started again.',
      tail ? `Installer output:\n${tail.trim().split('\n').slice(-12).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    buttons,
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
    noLink: true,
  });
  if (buttons[response] === 'Show Installer Log') {
    if (linuxInstaller) {
      shell.showItemInFolder(linuxInstaller.logPath);
    }
    await showInstallRecovery(message, isNewLaunch);
  } else if (buttons[response] === 'Start PM2 Captain') {
    // A fresh process of whatever is installed now, started by the user.
    linuxInstaller?.clearMarker();
    log.info('Starting after an incomplete update, as the user chose');
    await startBackendAndWindow();
  } else {
    isQuitAllowed = true;
    app.quit();
  }
}

/** True when an earlier installation left its marker and startup must wait for the user. */
async function handleInstallMarker(): Promise<boolean> {
  const marker = linuxInstaller?.readMarker();
  if (!marker || !linuxInstaller) {
    return false;
  }
  if (linuxInstaller.isMarkerInstallerRunning(marker)) {
    phase = 'recovery';
    showStatus('An update is being installed', 'Wait for the system installer to finish.');
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'PM2 Captain',
      message: 'An update is still being installed',
      detail: 'PM2 Captain starts once the system installer has finished.',
      buttons: ['Check Again', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      return handleInstallMarker();
    }
    app.quit();
    return true;
  }
  await showInstallRecovery(
    marker.exitCode !== null || marker.signal
      ? `Updating to ${marker.targetVersion} failed (${marker.signal ?? `exit code ${marker.exitCode}`}).`
      : `PM2 Captain closed while updating to ${marker.targetVersion}, so the result is not known.`,
    true
  );
  return true;
}

// ---------------------------------------------------------------------------
// Startup checks

/**
 * Records when Chromium's sandbox is off. The AppImage launcher turns it off
 * where user namespaces are unavailable (Ubuntu 24.04 and newer restrict them
 * with AppArmor), since an AppImage cannot carry the setuid helper. The app
 * runs either way; the renderer keeps context isolation and no Node access.
 */
function logSandboxState() {
  if (app.commandLine.hasSwitch('no-sandbox')) {
    log.warn('Running without the Chromium sandbox');
  }
}

/** A Mac app run from the disk image cannot update itself. */
async function offerMoveToApplications() {
  if (process.platform !== 'darwin' || !app.isPackaged || app.isInApplicationsFolder()) {
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'PM2 Captain',
    message: 'Move PM2 Captain to the Applications folder?',
    detail: 'PM2 Captain can only update itself from the Applications folder.',
    buttons: ['Move to Applications', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    try {
      app.moveToApplicationsFolder();
    } catch (error) {
      log.warn('Unable to move to the Applications folder', { error });
    }
  }
}

// ---------------------------------------------------------------------------
// IPC and menu

function registerIpc() {
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!isTrustedSender(event, trusted)) {
        log.warn('Rejected IPC from an untrusted sender', { channel });
        throw new Error('Not allowed.');
      }
      return handler(...args);
    });
  };
  handle(IPC_CHANNELS.loadPreferences, () => preferences.ui());
  handle(IPC_CHANNELS.getUpdateState, () => updates.state);
  handle(IPC_CHANNELS.checkForUpdates, () => updates.check());
  handle(IPC_CHANNELS.installUpdate, () => updates.install());
  handle(IPC_CHANNELS.skipUpdate, (version: unknown) => {
    if (typeof version !== 'string' || version.length === 0 || version.length > 200) {
      throw new Error('Invalid update version.');
    }
    return updates.skip(version);
  });
  ipcMain.on(IPC_CHANNELS.setPreference, (event, key: unknown, value: unknown) => {
    if (
      !isTrustedSender(event, trusted) ||
      typeof key !== 'string' ||
      !preferences.setUi(key, value)
    ) {
      log.warn('Rejected a preference change');
    }
  });
  updates.onState(state => {
    if (trusted && !trusted.window.isDestroyed()) {
      trusted.window.webContents.send(IPC_CHANNELS.updateState, state);
    }
    buildMenu();
  });
}

function updateMenuItem(): MenuItemConstructorOptions {
  const state = updates.state;
  if (state.status === 'downloaded' && state.version !== state.skippedVersion) {
    return {
      label: state.requiresAuthorization
        ? `Install Update ${state.version} (Asks for Your Password)…`
        : `Restart to Update to ${state.version}`,
      click: () => void updates.install(),
    };
  }
  return {
    label:
      state.status === 'downloading'
        ? `Downloading Update ${state.version ?? ''}…`
        : state.status === 'checking'
          ? 'Checking for Updates…'
          : 'Check for Updates…',
    enabled: !['disabled', 'checking', 'downloading', 'installing'].includes(state.status),
    click: () => {
      void updates.check().then(() => {
        const after = updates.state;
        if (after.status === 'idle') {
          void dialog.showMessageBox({
            type: 'info',
            title: 'PM2 Captain',
            message: `PM2 Captain ${after.currentVersion} is the latest version.`,
          });
        } else if (after.error) {
          void dialog.showMessageBox({
            type: 'warning',
            title: 'PM2 Captain',
            message: 'Checking for updates failed',
            detail: after.error.message,
          });
        }
      });
    },
  };
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const updateItem = updateMenuItem();
  const helpItems: MenuItemConstructorOptions[] = [
    ...(isMac ? [] : [updateItem]),
    {
      label: 'Release Notes',
      click: () => openExternalLink(`${RELEASES_URL}/tag/v${app.getVersion()}`, log),
    },
    { label: 'Report an Issue', click: () => openExternalLink(ISSUES_URL, log) },
    { label: 'Show Logs', click: () => shell.showItemInFolder(log.path) },
    ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'about' as const }]),
  ];
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              updateItem,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : [{ label: 'File', submenu: [{ role: 'quit' as const }] }]),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: helpItems },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Lifecycle

async function acquireSingleInstanceLock() {
  if (app.requestSingleInstanceLock()) {
    return true;
  }
  if (!isRelaunch) {
    return false;
  }
  // The version that started this one is still exiting.
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (app.requestSingleInstanceLock()) {
      return true;
    }
  }
  return false;
}

async function shutdown() {
  updates.stop();
  try {
    preferences.flush();
  } catch (error) {
    log.warn('Unable to save preferences', { error });
  }
  await backendHost.stop();
}

app.on('second-instance', () => {
  const window = mainWindow;
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
  }
});

app.on('before-quit', event => {
  if (isQuitAllowed) {
    return;
  }
  event.preventDefault();
  if (linuxInstaller?.isRunning) {
    void dialog.showMessageBox({
      type: 'info',
      title: 'PM2 Captain',
      message: 'An update is being installed',
      detail: 'PM2 Captain closes when the installation has finished.',
    });
    return;
  }
  if (phase === 'quitting') {
    return;
  }
  phase = 'quitting';
  void shutdown()
    .catch(error => log.error('Shutdown failed', { error }))
    .finally(() => {
      isQuitAllowed = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  // macOS keeps the app in the Dock until Quit; elsewhere closing the window quits.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  const run = backendHost.current;
  if (!mainWindow && run && phase === 'running') {
    void openWindowFor(run);
  }
});

async function main() {
  if (!(await acquireSingleInstanceLock())) {
    log.info('Another PM2 Captain window is open; focusing it');
    isQuitAllowed = true;
    app.quit();
    return;
  }
  await app.whenReady();
  app.setAboutPanelOptions({
    applicationName: 'PM2 Captain',
    applicationVersion: app.getVersion(),
    website: 'https://github.com/panta82/pm2-captain',
  });
  log.info('Starting', {
    version: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
  });
  registerIpc();
  buildMenu();
  logSandboxState();
  await offerMoveToApplications();
  updates.start();
  if (await handleInstallMarker()) {
    return;
  }
  await startBackendAndWindow();
}

main().catch(error => {
  log.error('Startup failed', { error });
  dialog.showErrorBox(
    'PM2 Captain could not start',
    error instanceof Error ? error.message : String(error)
  );
  isQuitAllowed = true;
  app.quit();
});
