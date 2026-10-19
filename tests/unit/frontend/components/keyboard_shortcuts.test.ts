// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IKeybindingSettings } from '../../../../src/shared/keybindings';

const api = vi.hoisted(() => ({ settings: undefined as IKeybindingSettings | undefined }));
vi.mock('../../../../src/frontend/lib/trpc', () => ({
  trpc: { settings: { keybindings: { useQuery: () => ({ data: api.settings }) } } },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const { KeyboardShortcutsProvider } =
  await import('../../../../src/frontend/components/keyboard_shortcuts');
const { useShortcutHandler } = await import('../../../../src/frontend/lib/keyboard_shortcuts');

function Handler({ onAction }: { onAction: () => boolean | void }) {
  useShortcutHandler('process.restart', onAction);
  return null;
}

/** A page with the controls the shortcuts press. */
function renderPage(children: ReturnType<typeof createElement>[] = []) {
  return render(createElement(KeyboardShortcutsProvider, null, ...children));
}

function button(label: string, attributes: Record<string, unknown> = {}) {
  return createElement('button', { key: label, type: 'button', ...attributes }, label);
}

/** Presses a key on the focused element, or the page, and tells whether it was taken. */
function press(init: KeyboardEventInit, target: Element = document.activeElement ?? document.body) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

const altR = { key: 'r', code: 'KeyR', altKey: true };

beforeEach(() => {
  api.settings = undefined;
});
afterEach(cleanup);

describe('keyboard shortcuts', () => {
  it('press the first control on screen that is enabled, with a plain click', () => {
    const clicks: string[] = [];
    const onClick = (event: { currentTarget: Element; ctrlKey: boolean; altKey: boolean }) =>
      clicks.push(`${event.currentTarget.textContent}:${event.ctrlKey || event.altKey}`);
    renderPage([
      button('disabled', { 'data-shortcut': 'process.restart', disabled: true, onClick }),
      button('hidden', { 'data-shortcut': 'process.restart', onClick }),
      button('restart', { 'data-shortcut': 'process.restart', onClick }),
    ]);
    screen.getByText('hidden').checkVisibility = () => false;

    expect(press(altR)).toBe(true);
    expect(clicks).toEqual(['restart:false']);
  });

  it('let keys through that have nothing to do', () => {
    renderPage();

    expect(press(altR)).toBe(false);
    // In a browser tab, Ctrl+F without a filter box is the browser's find.
    expect(press({ key: 'f', code: 'KeyF', ctrlKey: true })).toBe(false);
  });

  it('leave typed characters to text boxes', () => {
    renderPage([createElement('input', { key: 'input', 'aria-label': 'text' })]);

    screen.getByLabelText('text').focus();
    expect(press({ key: '?', code: 'Slash', shiftKey: true })).toBe(false);
    // Keys that move the caret stay with the box too.
    expect(press({ key: 'End', code: 'End' })).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => screen.getByLabelText('text').blur());
    expect(press({ key: '?', code: 'Slash', shiftKey: true })).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });

  it('keep away from an open dialog, except Ctrl+F', () => {
    const onClick = vi.fn();
    renderPage([
      button('restart', { 'data-shortcut': 'process.restart', onClick }),
      createElement(
        'div',
        { key: 'dialog', 'aria-modal': 'true' },
        createElement('input', { 'aria-label': 'search', 'data-find-target': 1 })
      ),
    ]);

    expect(press(altR)).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
    expect(press({ key: 'f', code: 'KeyF', ctrlKey: true })).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText('search'));
  });

  it('do not repeat an action while its key is held', () => {
    const onClick = vi.fn();
    renderPage([button('restart', { 'data-shortcut': 'process.restart', onClick })]);

    expect(press({ ...altR, repeat: true })).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('ask the newest handler first, and fall back when it has nothing to do', () => {
    const calls: string[] = [];
    const onClick = () => calls.push('button');
    const { rerender } = renderPage([
      button('restart', { 'data-shortcut': 'process.restart', onClick }),
      createElement(Handler, { key: 'outer', onAction: () => void calls.push('outer') }),
      createElement(Handler, { key: 'inner', onAction: () => calls.push('inner') > 99 }),
    ]);

    press(altR);
    expect(calls).toEqual(['inner', 'outer']);

    rerender(
      createElement(
        KeyboardShortcutsProvider,
        null,
        button('restart', { 'data-shortcut': 'process.restart', onClick }),
        createElement(Handler, { key: 'inner', onAction: () => false })
      )
    );
    press(altR);
    expect(calls).toEqual(['inner', 'outer', 'button']);
  });

  it("use the user's keys instead of the defaults", () => {
    api.settings = {
      path: '/config/keybindings.json',
      overrides: { 'process.restart': ['Ctrl+Shift+R'] },
      error: null,
    };
    const onClick = vi.fn();
    renderPage([button('restart', { 'data-shortcut': 'process.restart', onClick })]);

    expect(press(altR)).toBe(false);
    expect(press({ key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
