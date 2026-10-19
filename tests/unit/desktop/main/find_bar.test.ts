import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { FIND_BAR_CHANNELS } from '../../../../src/desktop/shared/ipc_channels';

const electron = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');

  class FakeWebContents extends EventEmitter {
    ipc = new EventEmitter();
    mainFrame = { url: 'data:text/html,find' };
    session = {};
    isDestroyedValue = false;
    findInPage = vi.fn(() => 1);
    stopFindInPage = vi.fn();
    focus = vi.fn();
    send = vi.fn();
    close = vi.fn();
    setWindowOpenHandler = vi.fn();
    loadURL = vi.fn(async () => undefined);
    isLoading = () => false;
    isDestroyed = () => this.isDestroyedValue;
  }

  class WebContentsView {
    static last: WebContentsView | null = null;
    webContents = new FakeWebContents();
    options: unknown;
    setBackgroundColor = vi.fn();
    setVisible = vi.fn();
    setBounds = vi.fn();

    constructor(options: unknown) {
      this.options = options;
      WebContentsView.last = this;
    }
  }

  return { FakeWebContents, WebContentsView, app: { isPackaged: true } };
});
vi.mock('electron', () => electron);

const { createFindBar, findBarPageURL } = await import('../../../../src/desktop/main/find_bar');

function setup() {
  const target = new electron.FakeWebContents();
  const window = Object.assign(new EventEmitter(), {
    webContents: target,
    contentView: { addChildView: vi.fn() },
    getContentSize: () => [1200, 800],
    isDestroyed: () => false,
  });
  const onOpenChange = vi.fn();
  const onBack = vi.fn();
  const bar = createFindBar({
    window: window as never,
    preloadPath: '/app/find_bar_preload.js',
    onOpenChange,
    onBack,
  });
  // The view is made when the bar is first opened.
  expect(electron.WebContentsView.last).toBeNull();
  bar.open();
  bar.close();
  onOpenChange.mockClear();
  const view = electron.WebContentsView.last!;
  electron.WebContentsView.last = null;
  const contents = view.webContents;
  /** A message as the bar's own page sends it. */
  const fromBar = (channel: string, ...args: unknown[]) =>
    contents.ipc.emit(channel, { senderFrame: contents.mainFrame }, ...args);
  return { bar, target, window, view, contents, onOpenChange, onBack, fromBar };
}

describe('find bar', () => {
  it('is a locked-down view of its own, sharing the page session', () => {
    const { view, target, contents } = setup();

    expect(view.options).toEqual({
      webPreferences: expect.objectContaining({
        preload: '/app/find_bar_preload.js',
        session: target.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
      }),
    });
    expect(contents.loadURL).toHaveBeenCalledWith(findBarPageURL());
    expect(decodeURIComponent(findBarPageURL())).toContain(
      `content="default-src 'none'; style-src 'unsafe-inline'"`
    );
    const event = { preventDefault: vi.fn() };
    contents.emit('will-navigate', event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('opens over the top-right corner, focused, and reports that once', () => {
    const { bar, view, contents, onOpenChange } = setup();

    bar.open();
    expect(bar.isOpen).toBe(true);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    expect(view.setBounds).toHaveBeenCalledWith({ x: 820, y: 58, width: 372, height: 60 });
    expect(contents.focus).toHaveBeenCalled();
    expect(contents.send).toHaveBeenLastCalledWith(FIND_BAR_CHANNELS.show, {
      isReopened: true,
      step: null,
    });

    bar.step(false);
    expect(contents.send).toHaveBeenLastCalledWith(FIND_BAR_CHANNELS.show, {
      isReopened: false,
      step: false,
    });
    expect(onOpenChange.mock.calls).toEqual([[true]]);
  });

  it('searches the page only for plain requests from its own page while open', () => {
    const { bar, target, contents, fromBar } = setup();

    fromBar(FIND_BAR_CHANNELS.find, 'api', true, true);
    expect(target.findInPage).not.toHaveBeenCalled();

    bar.open();
    fromBar(FIND_BAR_CHANNELS.find, 'api', true, true);
    fromBar(FIND_BAR_CHANNELS.find, 'api', false, false);
    expect(target.findInPage.mock.calls).toEqual([
      ['api', { forward: true, findNext: true }],
      ['api', { forward: false, findNext: false }],
    ]);

    // Another frame, or values that are not what the bar sends.
    contents.ipc.emit(FIND_BAR_CHANNELS.find, { senderFrame: { url: 'x' } }, 'api', true, true);
    contents.ipc.emit(FIND_BAR_CHANNELS.close, { senderFrame: null });
    fromBar(FIND_BAR_CHANNELS.find, { toString: () => 'api' }, true, true);
    fromBar(FIND_BAR_CHANNELS.find, '', true, true);
    fromBar(FIND_BAR_CHANNELS.find, 'x'.repeat(1_001), true, true);
    fromBar(FIND_BAR_CHANNELS.find, 'api', 'yes', true);
    expect(target.findInPage).toHaveBeenCalledTimes(2);
    expect(bar.isOpen).toBe(true);
  });

  it('passes on only the counts of each result', () => {
    const { bar, target, contents } = setup();
    bar.open();

    target.emit(
      'found-in-page',
      {},
      {
        requestId: 4,
        activeMatchOrdinal: 2,
        matches: 7,
        finalUpdate: true,
        selectionArea: { x: 1, y: 2, width: 3, height: 4 },
      }
    );
    expect(contents.send).toHaveBeenLastCalledWith(FIND_BAR_CHANNELS.result, {
      requestId: 4,
      activeMatchOrdinal: 2,
      matches: 7,
    });
  });

  it('closes on request, keeping the current match selected in the page', () => {
    const { bar, target, view, onOpenChange, fromBar } = setup();
    bar.open();

    fromBar(FIND_BAR_CHANNELS.stop);
    expect(target.stopFindInPage).toHaveBeenLastCalledWith('clearSelection');

    fromBar(FIND_BAR_CHANNELS.close);
    expect(bar.isOpen).toBe(false);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(target.stopFindInPage).toHaveBeenLastCalledWith('keepSelection');
    expect(target.focus).toHaveBeenCalled();
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });

  it('hands the focus back to the page on request, staying open', () => {
    const { bar, target, onBack, fromBar } = setup();
    fromBar(FIND_BAR_CHANNELS.back);
    expect(onBack).not.toHaveBeenCalled();

    bar.open();
    target.focus.mockClear();
    fromBar(FIND_BAR_CHANNELS.back);
    expect(target.focus).toHaveBeenCalled();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(bar.isOpen).toBe(true);
  });

  it('stays open through route changes, and closes for a new document', () => {
    const { bar, target } = setup();
    bar.open();

    target.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    target.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(bar.isOpen).toBe(true);
    target.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(bar.isOpen).toBe(false);
  });

  it('closes its view with the window', () => {
    const { window, contents, target } = setup();

    window.emit('closed');
    expect(contents.close).toHaveBeenCalled();
    expect(target.listenerCount('found-in-page')).toBe(0);
  });
});
