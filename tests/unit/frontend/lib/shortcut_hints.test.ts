import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHORTCUT_HINT_DELAY_MS,
  createShortcutHints,
} from '../../../../src/frontend/lib/shortcut_hints';

const key = (key: string, modifiers: Partial<KeyboardEvent> = {}) =>
  ({
    key,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  }) as KeyboardEvent;

const ctrlDown = key('Control', { ctrlKey: true });
const ctrlUp = key('Control');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shortcut hints', () => {
  it('appear once Ctrl is held alone for a moment, and go when it is let go', () => {
    const hints = createShortcutHints('Control');
    const listener = vi.fn();
    hints.subscribe(listener);

    hints.keyDown(ctrlDown);
    vi.advanceTimersByTime(SHORTCUT_HINT_DELAY_MS - 1);
    expect(hints.isVisible()).toBe(false);
    // A held key repeats; that is still the same press.
    hints.keyDown(key('Control', { ctrlKey: true, repeat: true }));
    vi.advanceTimersByTime(1);
    expect(hints.isVisible()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    hints.keyUp(ctrlUp);
    expect(hints.isVisible()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stay hidden through a chord such as Ctrl+C or Ctrl+Shift', () => {
    const hints = createShortcutHints('Control');

    hints.keyDown(ctrlDown);
    hints.keyDown(key('c', { ctrlKey: true }));
    vi.advanceTimersByTime(SHORTCUT_HINT_DELAY_MS * 3);
    expect(hints.isVisible()).toBe(false);

    hints.keyUp(ctrlUp);
    hints.keyDown(ctrlDown);
    hints.keyDown(key('Shift', { ctrlKey: true, shiftKey: true }));
    vi.advanceTimersByTime(SHORTCUT_HINT_DELAY_MS);
    expect(hints.isVisible()).toBe(false);
  });

  it('go away for a key, a click or a lost window, until Ctrl is pressed again', () => {
    const hints = createShortcutHints('Control');
    const showHints = () => {
      hints.keyDown(ctrlDown);
      vi.advanceTimersByTime(SHORTCUT_HINT_DELAY_MS);
      expect(hints.isVisible()).toBe(true);
    };

    showHints();
    hints.keyDown(key('3', { ctrlKey: true }));
    expect(hints.isVisible()).toBe(false);
    // Still held, but it was used for a shortcut.
    hints.keyDown(key('Control', { ctrlKey: true, repeat: true }));
    vi.advanceTimersByTime(SHORTCUT_HINT_DELAY_MS);
    expect(hints.isVisible()).toBe(false);

    hints.keyUp(ctrlUp);
    showHints();
    hints.reset();
    expect(hints.isVisible()).toBe(false);
  });

  it('notice a released Ctrl on any other key, when its keyup went missing', () => {
    const hints = createShortcutHints('Control');
    hints.keyDown(ctrlDown);
    vi.advanceTimersByTime(SHORTCUT_HINT_DELAY_MS);

    hints.keyUp(key('Shift'));
    expect(hints.isVisible()).toBe(false);
  });

  it('use Cmd on a Mac, and ignore Ctrl there', () => {
    const hints = createShortcutHints('Meta');

    hints.keyDown(ctrlDown);
    vi.advanceTimersByTime(SHORTCUT_HINT_DELAY_MS);
    expect(hints.isVisible()).toBe(false);

    hints.keyUp(ctrlUp);
    hints.keyDown(key('Meta', { metaKey: true }));
    vi.advanceTimersByTime(SHORTCUT_HINT_DELAY_MS);
    expect(hints.isVisible()).toBe(true);
  });
});
