import { describe, expect, it } from 'vitest';

import {
  type IKeyEventLike,
  formatAriaKeyShortcut,
  formatKeyCombo,
  matchesKeyCombo,
} from '../../../../src/frontend/lib/key_combo';
import { type IKeyCombo, parseKeyCombo } from '../../../../src/shared/keybindings';

const keys = (text: string) => parseKeyCombo(text) as IKeyCombo;

const press = (event: Partial<IKeyEventLike>): IKeyEventLike => ({
  key: '',
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...event,
});

describe('matchesKeyCombo', () => {
  it('uses Ctrl for Mod elsewhere and Cmd on a Mac', () => {
    const ctrlF = press({ key: 'f', code: 'KeyF', ctrlKey: true });
    const cmdF = press({ key: 'f', code: 'KeyF', metaKey: true });

    expect(matchesKeyCombo(ctrlF, keys('Mod+F'), false)).toBe(true);
    expect(matchesKeyCombo(cmdF, keys('Mod+F'), false)).toBe(false);
    expect(matchesKeyCombo(cmdF, keys('Mod+F'), true)).toBe(true);
    expect(matchesKeyCombo(ctrlF, keys('Mod+F'), true)).toBe(false);
  });

  it('finds the letter on layouts that do not type a Latin one there', () => {
    // Serbian Cyrillic types "ф" on the F key, a Mac types "®" for Option+R.
    expect(
      matchesKeyCombo(press({ key: 'ф', code: 'KeyF', ctrlKey: true }), keys('Mod+F'), false)
    ).toBe(true);
    expect(
      matchesKeyCombo(press({ key: '®', code: 'KeyR', altKey: true }), keys('Alt+R'), true)
    ).toBe(true);
  });

  it('keeps the typed Latin letter where a layout moves it', () => {
    // QWERTZ (Serbian Latin, German) types "z" on the key where QWERTY has Y.
    const z = press({ key: 'z', code: 'KeyY', ctrlKey: true });
    expect(matchesKeyCombo(z, keys('Ctrl+Z'), false)).toBe(true);
    expect(matchesKeyCombo(z, keys('Ctrl+Y'), false)).toBe(false);
    // Shift reports the capital letter.
    expect(
      matchesKeyCombo(
        press({ key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true }),
        keys('Mod+Shift+G'),
        false
      )
    ).toBe(true);
  });

  it('finds digits that a layout types as symbols', () => {
    // AZERTY types "&" on the 1 key without Shift; a Mac types "¡" for Option+1.
    expect(
      matchesKeyCombo(press({ key: '&', code: 'Digit1', ctrlKey: true }), keys('Mod+1'), false)
    ).toBe(true);
    expect(
      matchesKeyCombo(press({ key: '¡', code: 'Digit1', altKey: true }), keys('Alt+1'), true)
    ).toBe(true);
    expect(
      matchesKeyCombo(press({ key: '1', code: 'Numpad1', ctrlKey: true }), keys('Mod+1'), false)
    ).toBe(true);
    expect(
      matchesKeyCombo(press({ key: '2', code: 'Digit2', ctrlKey: true }), keys('Mod+1'), false)
    ).toBe(false);
  });

  it('requires exactly the modifiers of the combination', () => {
    const altR = keys('Alt+R');
    expect(matchesKeyCombo(press({ key: 'r', code: 'KeyR', altKey: true }), altR, false)).toBe(
      true
    );
    expect(
      matchesKeyCombo(press({ key: 'r', code: 'KeyR', altKey: true, shiftKey: true }), altR, false)
    ).toBe(false);
    // Windows reports AltGr as Ctrl+Alt, which types characters on many layouts.
    expect(
      matchesKeyCombo(press({ key: 'r', code: 'KeyR', altKey: true, ctrlKey: true }), altR, false)
    ).toBe(false);
    expect(matchesKeyCombo(press({ key: 'r', code: 'KeyR' }), altR, false)).toBe(false);
  });

  it('matches a symbol with or without the Shift its layout needs', () => {
    expect(
      matchesKeyCombo(press({ key: '?', code: 'Slash', shiftKey: true }), keys('?'), false)
    ).toBe(true);
    expect(
      matchesKeyCombo(press({ key: '?', code: 'Minus', shiftKey: true }), keys('?'), false)
    ).toBe(true);
    expect(matchesKeyCombo(press({ key: '/', code: 'Slash' }), keys('?'), false)).toBe(false);
    expect(
      matchesKeyCombo(
        press({ key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }),
        keys('?'),
        false
      )
    ).toBe(false);
  });

  it('matches named keys exactly', () => {
    expect(matchesKeyCombo(press({ key: 'F3', code: 'F3' }), keys('F3'), false)).toBe(true);
    expect(
      matchesKeyCombo(press({ key: 'F3', code: 'F3', shiftKey: true }), keys('F3'), false)
    ).toBe(false);
    expect(
      matchesKeyCombo(press({ key: 'F3', code: 'F3', shiftKey: true }), keys('Shift+F3'), false)
    ).toBe(true);
    expect(
      matchesKeyCombo(
        press({ key: 'ArrowDown', code: 'ArrowDown', altKey: true }),
        keys('Alt+ArrowDown'),
        false
      )
    ).toBe(true);
  });
});

describe('formatKeyCombo', () => {
  it('writes the keys the way each platform does', () => {
    expect(formatKeyCombo(keys('Mod+Shift+G'), false)).toBe('Ctrl+Shift+G');
    expect(formatKeyCombo(keys('Mod+Shift+G'), true)).toBe('⇧⌘G');
    expect(formatKeyCombo(keys('Alt+ArrowDown'), false)).toBe('Alt+↓');
    expect(formatKeyCombo(keys('Ctrl+Alt+R'), true)).toBe('⌃⌥R');
    expect(formatKeyCombo(keys('?'), false)).toBe('?');
    expect(formatKeyCombo(keys('Shift+F3'), false)).toBe('Shift+F3');
  });

  it('writes aria-keyshortcuts values', () => {
    expect(formatAriaKeyShortcut(keys('Mod+Shift+G'), false)).toBe('Control+Shift+G');
    expect(formatAriaKeyShortcut(keys('Mod+F'), true)).toBe('Meta+F');
    expect(formatAriaKeyShortcut(keys('Alt+ArrowUp'), false)).toBe('Alt+ArrowUp');
  });
});
