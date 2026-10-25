import type { ContextMenuParams } from 'electron';
import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  app: { isPackaged: true },
  clipboard: { writeText: vi.fn() },
  Menu: {},
}));
vi.mock('electron', () => electron);

const { contextMenuTemplate } = await import('../../../../src/desktop/main/context_menu');

const NO_EDITS = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false,
  canEditRichly: false,
};

function setup(params: Partial<ContextMenuParams>) {
  const contents = {
    getURL: () => 'http://127.0.0.1:4100/daemons',
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    inspectElement: vi.fn(),
  };
  const openLink = vi.fn();
  const template = contextMenuTemplate(
    {
      x: 10,
      y: 20,
      linkURL: '',
      isEditable: false,
      selectionText: '',
      editFlags: NO_EDITS,
      ...params,
    },
    contents,
    openLink
  );
  const item = (label: string) => {
    const found = template.find(candidate => candidate.label === label);
    if (!found) {
      throw new Error(`No "${label}" item`);
    }
    return {
      enabled: found.enabled ?? true,
      click: () => found.click?.({} as never, undefined, {} as never),
    };
  };
  const labels = template.map(candidate => candidate.label ?? '-');
  return { contents, openLink, item, labels };
}

describe('contextMenuTemplate', () => {
  it('offers Copy and Select All on the page', () => {
    const { contents, item, labels } = setup({ selectionText: 'GET /health 200' });

    expect(labels).toEqual(['Copy', 'Select All']);
    item('Copy').click();
    expect(contents.copy).toHaveBeenCalled();
    expect(setup({}).item('Copy').enabled).toBe(false);
  });

  it('offers the editing commands that a text field allows', () => {
    const { contents, item, labels } = setup({
      isEditable: true,
      editFlags: { ...NO_EDITS, canPaste: true, canSelectAll: true },
    });

    expect(labels).toEqual(['Undo', 'Redo', '-', 'Cut', 'Copy', 'Paste', '-', 'Select All']);
    expect(item('Cut').enabled).toBe(false);
    expect(item('Paste').enabled).toBe(true);
    item('Paste').click();
    expect(contents.paste).toHaveBeenCalled();
  });

  it('opens and copies links that leave the app', () => {
    const { openLink, item, labels } = setup({ linkURL: 'http://localhost:3000/' });

    expect(labels).toEqual([
      'Open Link in Browser',
      'Copy Link Address',
      '-',
      'Copy',
      'Select All',
    ]);
    item('Open Link in Browser').click();
    expect(openLink).toHaveBeenCalledWith('http://localhost:3000/');
    item('Copy Link Address').click();
    expect(electron.clipboard.writeText).toHaveBeenCalledWith('http://localhost:3000/');
  });

  it("leaves out the app's own links and links that are not web links", () => {
    for (const linkURL of [
      'http://127.0.0.1:4100/daemons/1/processes/2',
      'file:///etc/passwd',
      'javascript:alert(1)',
    ]) {
      expect(setup({ linkURL }).labels).toEqual(['Copy', 'Select All']);
    }
  });

  it('offers Inspect Element in development builds only', () => {
    electron.app.isPackaged = false;
    try {
      const { contents, item } = setup({});
      item('Inspect Element').click();
      expect(contents.inspectElement).toHaveBeenCalledWith(10, 20);
    } finally {
      electron.app.isPackaged = true;
    }
  });
});
