import {
  type RefObject,
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';

import { type IShortcutHints, createShortcutHints } from '@/lib/shortcut_hints';
import { isShown } from '@/lib/utils';

import type { IKeybindingSettings, IKeyboardActionId } from '@shared/keybindings';

/**
 * A control with `data-shortcut="<action>"` is clicked by the action's
 * shortcut, so the shortcut does exactly what the control does. The first one
 * on screen wins.
 */
export const SHORTCUT_ATTRIBUTE = 'data-shortcut';

/** Returns false when it had nothing to do, so the key does what it would otherwise. */
export type IShortcutHandler = (actionId: IKeyboardActionId) => boolean | void;

export interface IKeyboardShortcuts {
  isMac: boolean;
  /** Labels of each action's keys, as the UI shows them. */
  labels: Partial<Record<IKeyboardActionId, string[]>>;
  /** `aria-keyshortcuts` values. */
  ariaShortcuts: Partial<Record<IKeyboardActionId, string>>;
  /** Undefined until the backend has answered. */
  settings: IKeybindingSettings | undefined;
  hints: IShortcutHints;
  register(
    actionIds: readonly IKeyboardActionId[],
    handler: RefObject<IShortcutHandler>
  ): () => void;
}

// Outside the provider, as in component tests, nothing is bound and no hints show.
const KeyboardShortcutsContext = createContext<IKeyboardShortcuts>({
  isMac: false,
  labels: {},
  ariaShortcuts: {},
  settings: undefined,
  hints: createShortcutHints('Control'),
  register: () => () => undefined,
});

export const KeyboardShortcutsContextProvider = KeyboardShortcutsContext.Provider;

export function useKeyboardShortcuts() {
  return useContext(KeyboardShortcutsContext);
}

/**
 * Runs `handler` for the actions while the component is mounted and enabled.
 * The most recently mounted handler is asked first.
 */
export function useShortcutHandler(
  actionIds: IKeyboardActionId | readonly IKeyboardActionId[],
  handler: IShortcutHandler,
  isEnabled = true
) {
  const { register } = useKeyboardShortcuts();
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  const key = typeof actionIds === 'string' ? actionIds : actionIds.join(',');
  useEffect(() => {
    if (!isEnabled) {
      return;
    }
    return register(key.split(',') as IKeyboardActionId[], handlerRef);
  }, [register, key, isEnabled]);
}

export function useShortcutHintsVisible() {
  const { hints } = useKeyboardShortcuts();
  return useSyncExternalStore(hints.subscribe, hints.isVisible);
}

/** The action's first key, as the UI shows it, or null when it has none. */
export function useShortcutLabel(actionId: IKeyboardActionId): string | null {
  return useKeyboardShortcuts().labels[actionId]?.[0] ?? null;
}

/** The action's keys for `aria-keyshortcuts`. */
export function useShortcutAria(actionId: IKeyboardActionId): string | undefined {
  return useKeyboardShortcuts().ariaShortcuts[actionId];
}

/** Clicks the first enabled control on screen that the action belongs to. */
export function clickShortcutTarget(actionId: IKeyboardActionId): boolean {
  for (const element of document.querySelectorAll<HTMLElement>(
    `[${SHORTCUT_ATTRIBUTE}="${actionId}"]`
  )) {
    if (isShown(element) && !element.matches(':disabled, [aria-disabled="true"]')) {
      // A plain click, even though the shortcut's modifier is still held:
      // Ctrl+click on a process adds it to a selection, and a link clicked with
      // a modifier opens elsewhere.
      element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      );
      return true;
    }
  }
  return false;
}

/**
 * Marks the process list on screen: the sidebar, or the status page's rows.
 * The list itself takes the focus when it can; otherwise its first entry does.
 */
export const PROCESS_LIST_ATTRIBUTE = 'data-process-list';

/**
 * Moves the focus into the process list on screen, where the arrow keys go on:
 * to the list itself when it takes the focus, otherwise to its first or last
 * entry (a status table row, or a card's button).
 */
export function focusProcessList(isFromEnd = false): boolean {
  for (const list of document.querySelectorAll<HTMLElement>(`[${PROCESS_LIST_ATTRIBUTE}]`)) {
    if (!isShown(list)) {
      continue;
    }
    const entries = list.matches('[tabindex]')
      ? [list]
      : Array.from(list.querySelectorAll<HTMLElement>(':scope > [tabindex], :scope > * > button'));
    const target = isFromEnd ? entries.at(-1) : entries[0];
    if (target) {
      target.focus();
      return true;
    }
  }
  return false;
}

/**
 * Marks the scrolling content of the open process's tab. Enter in the process
 * list moves the focus there, where the keys scroll it, and Escape comes back.
 */
export const PROCESS_PANE_ATTRIBUTE = 'data-process-pane';

/** Moves the focus into the open process's tab, if one is on screen. */
export function focusProcessPane(): boolean {
  for (const pane of document.querySelectorAll<HTMLElement>(`[${PROCESS_PANE_ATTRIBUTE}]`)) {
    if (isShown(pane)) {
      pane.focus();
      return true;
    }
  }
  return false;
}

/** Where a key edits text, rather than being a shortcut. */
export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) {
    return true;
  }
  return (
    target instanceof HTMLInputElement &&
    !['button', 'checkbox', 'radio', 'range', 'reset', 'submit', 'color', 'file'].includes(
      target.type
    )
  );
}
