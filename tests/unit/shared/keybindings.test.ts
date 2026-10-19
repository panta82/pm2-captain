import { describe, expect, it } from 'vitest';

import {
  KEYBOARD_ACTIONS,
  parseKeyCombo,
  resolveKeybindings,
} from '../../../src/shared/keybindings';

const combo = (overrides: Partial<ReturnType<typeof parseKeyCombo> & object>) => ({
  mod: false,
  ctrl: false,
  meta: false,
  alt: false,
  shift: false,
  key: '',
  ...overrides,
});

describe('parseKeyCombo', () => {
  it('reads modifiers in any case and order, and normalizes the key', () => {
    expect(parseKeyCombo('Mod+Shift+G')).toEqual(combo({ mod: true, shift: true, key: 'g' }));
    expect(parseKeyCombo('shift+ctrl+g')).toEqual(combo({ ctrl: true, shift: true, key: 'g' }));
    expect(parseKeyCombo('Option+Command+F')).toEqual(combo({ alt: true, meta: true, key: 'f' }));
    expect(parseKeyCombo('Alt+arrowdown')).toEqual(combo({ alt: true, key: 'ArrowDown' }));
    expect(parseKeyCombo('F3')).toEqual(combo({ key: 'F3' }));
    expect(parseKeyCombo('?')).toEqual(combo({ key: '?' }));
    expect(parseKeyCombo('Ctrl++')).toEqual(combo({ ctrl: true, key: '+' }));
    expect(parseKeyCombo('Alt+Space')).toEqual(combo({ alt: true, key: ' ' }));
    expect(parseKeyCombo(' Alt+š ')).toEqual(combo({ alt: true, key: 'š' }));
  });

  it('refuses unknown names, repeated modifiers and missing keys', () => {
    for (const text of ['', 'Ctrl+', 'Hyper+F', 'Ctrl+Ctrl+F', 'Ctrl+Foo', 'Ctrl+F25', 'Ctrl+ ']) {
      expect(parseKeyCombo(text), text).toBeNull();
    }
  });

  it('accepts every default key', () => {
    for (const action of KEYBOARD_ACTIONS) {
      for (const text of [...action.desktopKeys, ...action.browserKeys]) {
        expect(parseKeyCombo(text), `${action.id}: ${text}`).not.toBeNull();
      }
    }
  });
});

describe('resolveKeybindings', () => {
  const keysOf = (bindings: ReturnType<typeof resolveKeybindings>, actionId: string) =>
    bindings.filter(binding => binding.actionId === actionId).map(binding => binding.text);

  it('leaves stepping through matches to the browser in a browser tab', () => {
    const desktop = resolveKeybindings('desktop', {});
    const browser = resolveKeybindings('browser', {});

    expect(keysOf(desktop, 'find.next')).toEqual(['Mod+G', 'F3']);
    expect(keysOf(browser, 'find.next')).toEqual([]);
    expect(keysOf(browser, 'find')).toEqual(['Mod+F']);
    expect(keysOf(browser, 'process.restart')).toEqual(['Alt+R']);
  });

  it('replaces defaults with the user keys, which are tried first', () => {
    const bindings = resolveKeybindings('browser', {
      'process.restart': ['Mod+K', 'F5'],
      'tab.info': ['Alt+1'],
      'daemon.picker': [],
    });

    expect(keysOf(bindings, 'process.restart')).toEqual(['Mod+K', 'F5']);
    expect(keysOf(bindings, 'tab.info')).toEqual(['Alt+1']);
    expect(keysOf(bindings, 'daemon.picker')).toEqual([]);
    // Mod+K is restart now, before any default that uses it.
    expect(bindings.find(binding => binding.text === 'Mod+K')?.actionId).toBe('process.restart');
    expect(bindings.slice(0, 3).map(binding => binding.actionId)).toEqual([
      'process.restart',
      'process.restart',
      'tab.info',
    ]);
  });
});
