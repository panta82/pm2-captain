import type { IKeyCombo } from '@shared/keybindings';

/** The part of a keyboard event that matching reads. */
export type IKeyEventLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>;

export function isMacPlatform(platform = navigator.platform) {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const DIGIT_CODE = /^(?:Digit|Numpad)(\d)$/;

/** A printable character other than a letter, digit or space, such as "?". */
function isSymbol(key: string) {
  return [...key].length === 1 && !/[\p{L}\p{N} ]/u.test(key);
}

function matchesKey(event: IKeyEventLike, key: string) {
  if (/^[a-z]$/.test(key)) {
    const typed = event.key.toLowerCase();
    return /^[a-z]$/.test(typed) ? typed === key : event.code === `Key${key.toUpperCase()}`;
  }
  if (/^\d$/.test(key)) {
    return /^\d$/.test(event.key) ? event.key === key : DIGIT_CODE.exec(event.code)?.[1] === key;
  }
  return event.key === key || event.key.toLowerCase() === key;
}

/**
 * Whether a key press is the combination. Letters and digits match the typed
 * character, so QWERTZ and AZERTY keep their letters. When the layout types no
 * Latin letter or digit there, the physical key decides: Ctrl+F on a Cyrillic
 * layout types "ф", Option+R on a Mac types "®". Modifiers must match exactly,
 * so AltGr, which Windows reports as Ctrl+Alt, never triggers an Alt shortcut.
 */
export function matchesKeyCombo(event: IKeyEventLike, combo: IKeyCombo, isMac: boolean) {
  const ctrl = combo.ctrl || (combo.mod && !isMac);
  const meta = combo.meta || (combo.mod && isMac);
  if (event.ctrlKey !== ctrl || event.metaKey !== meta || event.altKey !== combo.alt) {
    return false;
  }
  // Most layouts need Shift to type a symbol such as "?", others do not.
  if (!isSymbol(combo.key) && event.shiftKey !== combo.shift) {
    return false;
  }
  return matchesKey(event, combo.key);
}

const KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space',
  Escape: 'Esc',
  Delete: 'Del',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

/** "Ctrl+Shift+G" elsewhere, "⇧⌘G" on a Mac. */
export function formatKeyCombo(combo: IKeyCombo, isMac: boolean) {
  const ctrl = combo.ctrl || (combo.mod && !isMac);
  const meta = combo.meta || (combo.mod && isMac);
  const key =
    KEY_LABELS[combo.key] ?? (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  const shift = combo.shift && !isSymbol(combo.key);
  if (isMac) {
    return `${ctrl ? '⌃' : ''}${combo.alt ? '⌥' : ''}${shift ? '⇧' : ''}${meta ? '⌘' : ''}${key}`;
  }
  return [ctrl && 'Ctrl', meta && 'Meta', combo.alt && 'Alt', shift && 'Shift', key]
    .filter(Boolean)
    .join('+');
}

/** The combination in `aria-keyshortcuts` form, such as "Control+Shift+G". */
export function formatAriaKeyShortcut(combo: IKeyCombo, isMac: boolean) {
  const ctrl = combo.ctrl || (combo.mod && !isMac);
  const meta = combo.meta || (combo.mod && isMac);
  const key =
    combo.key === ' ' ? 'Space' : combo.key.length === 1 ? combo.key.toUpperCase() : combo.key;
  return [ctrl && 'Control', combo.alt && 'Alt', combo.shift && 'Shift', meta && 'Meta', key]
    .filter(Boolean)
    .join('+');
}
