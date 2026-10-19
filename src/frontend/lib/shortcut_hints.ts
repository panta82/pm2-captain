/** How long Ctrl (Cmd on a Mac) is held alone before the shortcut hints appear. */
export const SHORTCUT_HINT_DELAY_MS = 300;

type IHintKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>;

/**
 * Shows the shortcut hints while the shortcut modifier is held on its own.
 * Anything else that happens meanwhile (another key, another modifier, a click
 * or the wheel) makes it a chord, such as Ctrl+C or Ctrl+click, and the hints
 * stay hidden until the modifier is pressed again. That keeps them from
 * flashing during ordinary shortcuts.
 */
export function createShortcutHints(modifierKey: 'Control' | 'Meta') {
  let isVisible = false;
  /** The modifier went down alone, and nothing else happened since. */
  let isArmed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const setVisible = (next: boolean) => {
    if (isVisible !== next) {
      isVisible = next;
      for (const listener of listeners) {
        listener();
      }
    }
  };

  const reset = () => {
    isArmed = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    setVisible(false);
  };

  const isModifierAlone = (event: IHintKeyEvent) =>
    modifierKey === 'Control'
      ? event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      : event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;

  return {
    keyDown(event: IHintKeyEvent) {
      if (event.key !== modifierKey || !isModifierAlone(event)) {
        reset();
        return;
      }
      // Some systems repeat a held modifier; that is still the same press.
      if (event.repeat || isArmed) {
        return;
      }
      isArmed = true;
      timer = setTimeout(() => {
        timer = null;
        setVisible(true);
      }, SHORTCUT_HINT_DELAY_MS);
    },
    keyUp(event: IHintKeyEvent) {
      // A keyup can go missing, for example when a dictation tool types for the
      // user, so a released modifier is also noticed on any other key.
      if (event.key === modifierKey || !isModifierAlone(event)) {
        reset();
      }
    },
    /** A click, the wheel, a paste, or the window losing focus. */
    reset,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isVisible: () => isVisible,
  };
}

export type IShortcutHints = ReturnType<typeof createShortcutHints>;
