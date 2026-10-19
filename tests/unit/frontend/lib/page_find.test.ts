// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IDesktopBridge } from '../../../../src/shared/desktop_bridge';

type IPageFind = typeof import('../../../../src/frontend/lib/page_find');

/** Loads page_find as a browser tab or, with a bridge, as the desktop app sees it. */
async function load(bridge?: IDesktopBridge['find']) {
  vi.resetModules();
  if (bridge) {
    window.pm2CaptainDesktop = { find: bridge } as IDesktopBridge;
  } else {
    delete window.pm2CaptainDesktop;
  }
  return (await import('../../../../src/frontend/lib/page_find')) as IPageFind;
}

function fakeFindBar() {
  let notifyOpen: (isOpen: boolean) => void = () => undefined;
  let notifyBack: () => void = () => undefined;
  const bar = {
    open: vi.fn(),
    step: vi.fn(),
    onOpenChange: vi.fn((listener: (isOpen: boolean) => void) => {
      notifyOpen = listener;
      return () => undefined;
    }),
    onBack: vi.fn((listener: () => void) => {
      notifyBack = listener;
      return () => undefined;
    }),
  };
  return { bar, setOpen: (isOpen: boolean) => notifyOpen(isOpen), back: () => notifyBack() };
}

function addFilter(step: number | null, value = '', parent: HTMLElement = document.body) {
  const input = document.createElement('input');
  if (step !== null) {
    input.setAttribute('data-find-target', String(step));
  }
  input.value = value;
  parent.append(input);
  return input;
}

/** The log boxes come first in the page here, but the process filter goes first. */
function addLogsPage() {
  const firstLogBox = addFilter(2, 'error');
  const secondLogBox = addFilter(2, 'timeout');
  const processFilter = addFilter(1, 'api');
  addFilter(null);
  return { processFilter, firstLogBox, secondLogBox };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  delete window.pm2CaptainDesktop;
});

describe('Ctrl+F in a browser tab', () => {
  it('goes through every filter box in order, with its text selected', async () => {
    const { runFind } = await load();
    const { processFilter, firstLogBox, secondLogBox } = addLogsPage();

    expect(runFind()).toBe(true);
    expect(document.activeElement).toBe(processFilter);
    expect([processFilter.selectionStart, processFilter.selectionEnd]).toEqual([0, 3]);
    expect(runFind()).toBe(true);
    expect(document.activeElement).toBe(firstLogBox);
    expect(runFind()).toBe(true);
    expect(document.activeElement).toBe(secondLogBox);
    // After the last box, the browser's own find.
    expect(runFind()).toBe(false);
    expect(document.activeElement).toBe(secondLogBox);
  });

  it('goes back with Ctrl+Shift+F, and stays at the first box', async () => {
    const { runFindBack } = await load();
    const { processFilter, firstLogBox, secondLogBox } = addLogsPage();

    // From outside the boxes, back starts at the last one.
    expect(runFindBack()).toBe(true);
    expect(document.activeElement).toBe(secondLogBox);
    expect(runFindBack()).toBe(true);
    expect(document.activeElement).toBe(firstLogBox);
    expect(runFindBack()).toBe(true);
    expect(document.activeElement).toBe(processFilter);
    expect(runFindBack()).toBe(true);
    expect(document.activeElement).toBe(processFilter);
  });

  it('leaves a page without a filter box to the browser', async () => {
    const { runFind, runFindBack } = await load();
    expect(runFind()).toBe(false);
    expect(runFindBack()).toBe(false);
  });

  it('skips boxes that are not on screen', async () => {
    const { nextFindTarget } = await load();
    const hidden = addFilter(1);
    hidden.checkVisibility = () => false;
    const shown = addFilter(2);

    expect(nextFindTarget()).toBe(shown);
  });

  it('keeps to an open dialog', async () => {
    const { nextFindTarget } = await load();
    addFilter(1);
    const dialog = document.createElement('section');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);

    expect(nextFindTarget()).toBeNull();
    const inDialog = addFilter(1, '', dialog);
    expect(nextFindTarget()).toBe(inDialog);
  });

  it('has no find bar to step through', async () => {
    const { stepFind } = await load();
    expect(stepFind(true)).toBe(false);
  });
});

describe('Ctrl+F in the desktop app', () => {
  it('opens the find bar after the last filter box, or where there is none', async () => {
    const { bar } = fakeFindBar();
    const { runFind } = await load(bar);

    expect(runFind()).toBe(true);
    expect(bar.open).toHaveBeenCalledTimes(1);

    const filter = addFilter(1);
    expect(runFind()).toBe(true);
    expect(document.activeElement).toBe(filter);
    expect(runFind()).toBe(true);
    expect(bar.open).toHaveBeenCalledTimes(2);
  });

  it('goes back to a find bar that is still open, from outside the boxes', async () => {
    const { bar, setOpen } = fakeFindBar();
    const { runFind } = await load(bar);
    const { processFilter, firstLogBox } = addLogsPage();

    setOpen(true);
    expect(runFind()).toBe(true);
    expect(bar.open).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(processFilter);

    // From a box, it goes on to the next one as usual.
    processFilter.focus();
    runFind();
    expect(document.activeElement).toBe(firstLogBox);
  });

  it('comes back from the find bar to the last filter box', async () => {
    const { bar, setOpen, back } = fakeFindBar();
    await load(bar);
    const { secondLogBox } = addLogsPage();

    setOpen(true);
    back();
    expect(document.activeElement).toBe(secondLogBox);
  });

  it('steps through the matches with the find bar', async () => {
    const { bar } = fakeFindBar();
    const { stepFind } = await load(bar);

    expect(stepFind(false)).toBe(true);
    expect(bar.step).toHaveBeenCalledWith(false);
  });
});
