import { BrowserWindow, Session, app, session, shell } from 'electron';
import libPath from 'node:path';

import { AUTH_COOKIE_NAME } from '../../shared/session';
import type { IBackendRun } from './backend_host';
import type { IFileLog } from './desktop_log';
import type { IPreferenceStore } from './preferences';

const BACKGROUND_COLOR = '#041522';
const DEFAULT_SIZE = { width: 1400, height: 900 };

/** Opens a link in the system browser. Only web links leave the app. */
export function openExternalLink(url: string, log: IFileLog) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol === 'https:') {
    void shell.openExternal(parsed.toString());
  } else {
    log.warn('Blocked a link that is not https', { protocol: parsed.protocol });
  }
}

/**
 * Locks down the window's own session: no permissions, and downloads only for
 * files the trusted page makes itself, such as the filtered log export.
 */
function secureSession(windowSession: Session, origin: string, log: IFileLog) {
  windowSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  );
  windowSession.setPermissionCheckHandler(() => false);
  windowSession.on('will-download', (event, item, webContents) => {
    const url = item.getURL();
    const owner = webContents ? BrowserWindow.fromWebContents(webContents) : null;
    if (!url.startsWith(`blob:${origin}/`) || !owner) {
      event.preventDefault();
      log.warn('Blocked a download that did not come from the Captain page');
      return;
    }
    // Electron asks where to save, starting here.
    item.setSaveDialogOptions({
      title: 'Save logs',
      defaultPath: libPath.join(app.getPath('downloads'), item.getFilename()),
    });
    item.once('done', (_event, state) => log.info('Download finished', { state }));
  });
}

/** The window shows the backend of one run, in an in-memory session of its own. */
export async function createMainWindow({
  run,
  preferences,
  preloadPath,
  iconPath,
  log,
}: {
  run: IBackendRun;
  preferences: IPreferenceStore;
  preloadPath: string;
  iconPath: string | null;
  log: IFileLog;
}) {
  const origin = run.baseURL;
  // No "persist:" prefix: cookies and storage disappear with the run, so an old
  // session can never reach a later backend.
  const partition = `captain-${run.runId}`;
  const windowSession = session.fromPartition(partition, { cache: false });
  secureSession(windowSession, origin, log);

  const saved = preferences.window();
  const window = new BrowserWindow({
    ...(saved ?? DEFAULT_SIZE),
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'PM2 Captain',
    backgroundColor: BACKGROUND_COLOR,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: preloadPath,
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  if (saved?.isMaximized) {
    window.maximize();
  }
  window.once('ready-to-show', () => window.show());

  const contents = window.webContents;
  const isOwnOrigin = (url: string) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };
  contents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url, log);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isOwnOrigin(url)) {
      event.preventDefault();
      openExternalLink(url, log);
    }
  });
  contents.on('will-redirect', (event, url) => {
    if (!isOwnOrigin(url)) {
      event.preventDefault();
    }
  });
  contents.on('will-attach-webview', event => event.preventDefault());

  const rememberBounds = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) {
      return;
    }
    const isMaximized = window.isMaximized();
    const bounds = window.getNormalBounds();
    preferences.setWindow({ ...bounds, isMaximized });
  };
  window.on('resize', rememberBounds);
  window.on('move', rememberBounds);
  window.on('maximize', rememberBounds);
  window.on('unmaximize', rememberBounds);
  window.on('close', rememberBounds);

  // The session cookie is set directly, the way /launch would set it, so the
  // token never appears in a URL, the history or an error message.
  await windowSession.cookies.set({
    url: origin,
    name: AUTH_COOKIE_NAME,
    value: run.launchToken,
    httpOnly: true,
    sameSite: 'strict',
    secure: false,
    path: '/',
  });
  return { window, origin, load: () => window.loadURL(`${origin}/`) };
}

/** A plain page shown while the backend is not available. It loads nothing else. */
export function statusPageURL(title: string, message: string) {
  const escape = (text: string) =>
    text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8"><title>PM2 Captain</title><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,sans-serif;background:${BACKGROUND_COLOR};color:#fff"><div style="max-width:32rem;padding:2rem;text-align:center"><h1 style="font-size:1.25rem;font-weight:600">${escape(title)}</h1><p style="line-height:1.5;opacity:.8">${escape(message)}</p></div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
