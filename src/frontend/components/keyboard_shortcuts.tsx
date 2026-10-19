import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import {
  formatAriaKeyShortcut,
  formatKeyCombo,
  isMacPlatform,
  matchesKeyCombo,
} from '@/lib/key_combo';
import {
  type IKeyboardShortcuts,
  type IShortcutHandler,
  KeyboardShortcutsContextProvider,
  clickShortcutTarget,
  focusProcessList,
  isTypingTarget,
  useShortcutHintsVisible,
  useShortcutLabel,
} from '@/lib/keyboard_shortcuts';
import { modalRoot, runFind, runFindBack, stepFind } from '@/lib/page_find';
import { desktopBridge } from '@/lib/preferences';
import { createShortcutHints } from '@/lib/shortcut_hints';
import { trpc } from '@/lib/trpc';

import { type IKeyboardActionId, keyboardAction, resolveKeybindings } from '@shared/keybindings';

import { Kbd } from './shortcut_hint';
import { ShortcutsDialog } from './shortcuts_dialog';

/** While the hints show, the keys that have no control on screen to show them on. */
function ShortcutHintBar() {
  const isVisible = useShortcutHintsVisible();
  const previous = useShortcutLabel('process.previous');
  const next = useShortcutLabel('process.next');
  const help = useShortcutLabel('shortcuts.help');
  if (!isVisible || (!help && !previous && !next)) {
    return null;
  }
  return (
    <div
      data-component="ShortcutHintBar"
      aria-hidden
      className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-lg border border-line bg-surface-plane px-4 py-2.5 text-xs whitespace-nowrap text-control-muted shadow-2xl"
    >
      {previous && next ? (
        <span className="flex items-center gap-1.5">
          <Kbd>{previous}</Kbd>
          <Kbd>{next}</Kbd>
          Previous and next process
        </span>
      ) : null}
      {help ? (
        <span className="flex items-center gap-1.5">
          <Kbd>{help}</Kbd>
          All shortcuts
        </span>
      ) : null}
    </div>
  );
}

/**
 * Captain's keyboard shortcuts. One window listener matches every key press
 * against the keys in effect: the defaults of the desktop app or of a browser
 * tab, with the user's keybindings.json over them.
 */
export function KeyboardShortcutsProvider({ children }: { children: ReactNode }) {
  const [isMac] = useState(() => isMacPlatform());
  const [hints] = useState(() => createShortcutHints(isMac ? 'Meta' : 'Control'));
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const registryRef = useRef(new Map<IKeyboardActionId, RefObject<IShortcutHandler>[]>());
  const settings = trpc.settings.keybindings.useQuery().data;
  const overrides = settings?.overrides;
  const bindings = useMemo(
    () => resolveKeybindings(desktopBridge ? 'desktop' : 'browser', overrides ?? {}),
    [overrides]
  );

  const register = useCallback(
    (actionIds: readonly IKeyboardActionId[], handler: RefObject<IShortcutHandler>) => {
      const registry = registryRef.current;
      for (const actionId of actionIds) {
        registry.set(actionId, [...(registry.get(actionId) ?? []), handler]);
      }
      return () => {
        for (const actionId of actionIds) {
          registry.set(
            actionId,
            (registry.get(actionId) ?? []).filter(candidate => candidate !== handler)
          );
        }
      };
    },
    []
  );
  const value = useMemo((): IKeyboardShortcuts => {
    const labels: IKeyboardShortcuts['labels'] = {};
    const ariaShortcuts: IKeyboardShortcuts['ariaShortcuts'] = {};
    for (const { actionId, combo } of bindings) {
      (labels[actionId] ??= []).push(formatKeyCombo(combo, isMac));
      const aria = formatAriaKeyShortcut(combo, isMac);
      ariaShortcuts[actionId] = ariaShortcuts[actionId]
        ? `${ariaShortcuts[actionId]} ${aria}`
        : aria;
    }
    return { isMac, labels, ariaShortcuts, settings, hints, register };
  }, [bindings, hints, isMac, register, settings]);

  const error = settings?.error ?? null;
  const path = settings?.path;
  useEffect(() => {
    if (error) {
      toast.error(`Keyboard shortcuts: ${error}`, {
        id: 'keybindings-error',
        description: `${path} is ignored until it is fixed; the default keys apply.`,
        duration: 10_000,
      });
    }
  }, [error, path]);

  useEffect(() => {
    const run = (actionId: IKeyboardActionId): boolean => {
      switch (actionId) {
        case 'find':
          return runFind();
        case 'find.back':
          return runFindBack();
        case 'find.next':
          return stepFind(true);
        case 'find.previous':
          return stepFind(false);
        case 'shortcuts.help':
          setIsHelpOpen(true);
          return true;
      }
      // The most recently mounted handler first.
      for (const handler of [...(registryRef.current.get(actionId) ?? [])].reverse()) {
        if (handler.current(actionId) !== false) {
          return true;
        }
      }
      return clickShortcutTarget(actionId);
    };

    // Capture: the shortcuts come before the page's own key handling.
    const handleKeyDown = (event: KeyboardEvent) => {
      hints.keyDown(event);
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      const binding = bindings.find(candidate => matchesKeyCombo(event, candidate.combo, isMac));
      if (!binding) {
        // With nothing focused, Up and Down go into the process list.
        const isArrow = event.key === 'ArrowDown' || event.key === 'ArrowUp';
        const hasModifier = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
        const isNothingFocused =
          !document.activeElement || document.activeElement === document.body;
        if (
          isArrow &&
          !hasModifier &&
          isNothingFocused &&
          !modalRoot() &&
          focusProcessList(event.key === 'ArrowUp')
        ) {
          event.preventDefault();
        }
        return;
      }
      const { actionId, combo } = binding;
      // In a text box, a key without Ctrl or Alt types or moves the caret,
      // such as "1" or End. Function keys such as F3 still work there.
      const isEditingKey =
        !combo.mod && !combo.ctrl && !combo.meta && !combo.alt && !/^F\d+$/.test(combo.key);
      if (isEditingKey && isTypingTarget(event.target)) {
        return;
      }
      // An open dialog keeps the keys; only Ctrl+F still works in it.
      if (actionId !== 'find' && actionId !== 'find.back' && modalRoot()) {
        return;
      }
      if (event.repeat && !keyboardAction(actionId).isRepeatable) {
        event.preventDefault();
        return;
      }
      if (run(actionId)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', hints.keyUp, true);
    window.addEventListener('pointerdown', hints.reset, true);
    window.addEventListener('wheel', hints.reset, { capture: true, passive: true });
    window.addEventListener('paste', hints.reset, true);
    window.addEventListener('blur', hints.reset);
    document.addEventListener('visibilitychange', hints.reset);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', hints.keyUp, true);
      window.removeEventListener('pointerdown', hints.reset, true);
      window.removeEventListener('wheel', hints.reset, { capture: true });
      window.removeEventListener('paste', hints.reset, true);
      window.removeEventListener('blur', hints.reset);
      document.removeEventListener('visibilitychange', hints.reset);
      hints.reset();
    };
  }, [bindings, hints, isMac]);

  return (
    <KeyboardShortcutsContextProvider value={value}>
      {children}
      <ShortcutHintBar />
      {isHelpOpen ? <ShortcutsDialog onClose={() => setIsHelpOpen(false)} /> : null}
    </KeyboardShortcutsContextProvider>
  );
}
