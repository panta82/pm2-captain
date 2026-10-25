// The window's find bar: a small view of its own over the top-right corner of
// the Captain page, searching that page with Chromium's find (findInPage), as a
// browser's Ctrl+F does. Being outside the page, its text box never matches
// itself, and typing in it never moves the page's current match.
import { type BrowserWindow, type IpcMainEvent, WebContentsView, app } from 'electron';

import { FIND_BAR_CHANNELS, type IFindBarResult, type IFindBarShow } from '../shared/ipc_channels';
import { attachContextMenu } from './context_menu';

/** The view's size, with room around the bar for its shadow. */
const WIDTH = 372;
const HEIGHT = 60;
/** Just under the Captain header, by the window's right edge. */
const TOP = 58;
const RIGHT = 8;
const MAX_QUERY_LENGTH = 1_000;

export interface IFindBar {
  readonly isOpen: boolean;
  /** Shows the bar, or focuses it, with its text selected. */
  open(): void;
  /** Goes to the next or previous match, opening the bar if needed. */
  step(isForward: boolean): void;
  close(): void;
}

const ICON = (paths: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${paths
    .split('|')
    .map(path => `<path d="${path}"/>`)
    .join('')}</svg>`;

/** Captain's design tokens, copied from the frontend's styles.css. The page loads nothing. */
const STYLE = `
:root { color-scheme: dark; }
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
body { box-sizing: border-box; padding: 6px 8px 14px; font: 13px system-ui, sans-serif; color: #fff; }
.bar { display: flex; align-items: center; gap: 2px; height: 40px; padding: 0 6px; box-sizing: border-box;
  background: #041522; border: 1px solid #153b55; border-radius: 10px; box-shadow: 0 8px 20px rgb(0 0 0 / 55%); }
.field { display: flex; flex: 1; align-items: center; min-width: 0; height: 28px; margin-right: 4px; padding: 0 8px;
  box-sizing: border-box; background: #020b12; border: 1px solid #153b55; border-radius: 7px; }
.field:focus-within { background: #041822; border-color: rgb(57 191 255 / 60%); }
input { flex: 1; min-width: 0; padding: 0; border: 0; outline: 0; background: transparent; color: #fff;
  font: 12px ui-monospace, SFMono-Regular, monospace; }
input::placeholder { color: rgb(112 144 170 / 70%); }
.count { flex: none; margin-left: 8px; color: #7090aa; font: 11px ui-monospace, SFMono-Regular, monospace; white-space: nowrap; }
.count[data-empty] { color: #ff5d73; }
button { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: hsl(211 26% 70%); cursor: pointer; }
button:hover:not(:disabled) { background: #0b263b; color: #fff; }
button:focus-visible { outline: 2px solid #39bfff; outline-offset: -2px; }
button:disabled { opacity: 0.45; cursor: default; }
svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
`;

/** A page without scripts or resources. The bar's own preload makes it work. */
export function findBarPageURL() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Find in page</title><style>${STYLE}</style></head><body>
<div class="bar" role="search">
<label class="field"><input id="query" type="text" placeholder="Find in page" aria-label="Find in page" spellcheck="false" autocomplete="off"><span id="count" class="count" aria-live="polite"></span></label>
<button id="previous" type="button" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled>${ICON('m5 12 7-7 7 7|M12 19V5')}</button>
<button id="next" type="button" title="Next match (Enter)" aria-label="Next match" disabled>${ICON('M12 5v14|m19 12-7 7-7-7')}</button>
<button id="close" type="button" title="Close (Esc)" aria-label="Close">${ICON('M18 6 6 18|m6 6 12 12')}</button>
</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Adds a find bar to a Captain window. It lives as long as the window. */
export function createFindBar({
  window,
  preloadPath,
  onOpenChange,
  onBack,
}: {
  window: BrowserWindow;
  preloadPath: string;
  onOpenChange: (isOpen: boolean) => void;
  /** The page takes the focus back, for its last filter box. */
  onBack: () => void;
}): IFindBar {
  const target = window.webContents;
  let view: WebContentsView | null = null;
  let isOpen = false;

  const layout = (current: WebContentsView) => {
    const [width] = window.getContentSize();
    current.setBounds({
      x: Math.max(0, width - WIDTH - RIGHT),
      y: TOP,
      width: WIDTH,
      height: HEIGHT,
    });
  };

  const close = () => {
    if (!isOpen) {
      return;
    }
    isOpen = false;
    view?.setVisible(false);
    if (!target.isDestroyed()) {
      // As in a browser, the current match stays selected.
      target.stopFindInPage('keepSelection');
      target.focus();
    }
    onOpenChange(false);
  };

  /** The bar's view, made when it is first needed. Most windows never are searched. */
  const ensureView = () => {
    if (view) {
      return view;
    }
    const created = new WebContentsView({
      webPreferences: {
        preload: preloadPath,
        session: target.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    const contents = created.webContents;
    // The bar draws its own rounded box on a transparent view.
    created.setBackgroundColor('#00000000');
    created.setVisible(false);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    attachContextMenu(contents, window, null);

    // Only the bar's own page may drive the search, and only with plain values.
    const isFromBar = (event: IpcMainEvent) => event.senderFrame === contents.mainFrame;
    contents.ipc.on(
      FIND_BAR_CHANNELS.find,
      (event, text: unknown, isForward: unknown, isNewSearch: unknown) => {
        if (
          !isFromBar(event) ||
          !isOpen ||
          typeof text !== 'string' ||
          !text ||
          text.length > MAX_QUERY_LENGTH ||
          typeof isForward !== 'boolean' ||
          typeof isNewSearch !== 'boolean'
        ) {
          return;
        }
        target.findInPage(text, { forward: isForward, findNext: isNewSearch });
      }
    );
    contents.ipc.on(FIND_BAR_CHANNELS.stop, event => {
      if (isFromBar(event)) {
        target.stopFindInPage('clearSelection');
      }
    });
    contents.ipc.on(FIND_BAR_CHANNELS.close, event => {
      if (isFromBar(event)) {
        close();
      }
    });
    contents.ipc.on(FIND_BAR_CHANNELS.back, event => {
      if (isFromBar(event) && isOpen && !target.isDestroyed()) {
        target.focus();
        onBack();
      }
    });
    void contents.loadURL(findBarPageURL()).catch(() => undefined);
    view = created;
    return created;
  };

  const show = (step: boolean | null) => {
    if (window.isDestroyed()) {
      return;
    }
    const current = ensureView();
    const contents = current.webContents;
    if (contents.isDestroyed()) {
      return;
    }
    const isReopened = !isOpen;
    isOpen = true;
    // Adding it again puts it above any view added since.
    window.contentView.addChildView(current);
    layout(current);
    current.setVisible(true);
    contents.focus();
    const message: IFindBarShow = { isReopened, step };
    const notify = () => contents.send(FIND_BAR_CHANNELS.show, message);
    if (contents.isLoading()) {
      contents.once('did-finish-load', notify);
    } else {
      notify();
    }
    if (isReopened) {
      onOpenChange(true);
    }
  };

  const forwardResult = (_event: unknown, result: Electron.Result) => {
    if (view && !view.webContents.isDestroyed()) {
      const message: IFindBarResult = {
        requestId: result.requestId,
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      };
      view.webContents.send(FIND_BAR_CHANNELS.result, message);
    }
  };
  // A new document replaces the page the matches were in; the app's own
  // route changes keep the same document and the bar.
  const closeOnNewDocument = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) {
      close();
    }
  };
  target.on('found-in-page', forwardResult);
  target.on('did-start-navigation', closeOnNewDocument);
  window.on('resize', () => {
    if (isOpen && view) {
      layout(view);
    }
  });
  window.once('closed', () => {
    if (!target.isDestroyed()) {
      target.off('found-in-page', forwardResult);
      target.off('did-start-navigation', closeOnNewDocument);
    }
    // A view's web contents outlive its window unless closed.
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.close();
    }
  });

  return {
    get isOpen() {
      return isOpen;
    },
    open: () => show(null),
    step: isForward => show(isForward),
    close,
  };
}
