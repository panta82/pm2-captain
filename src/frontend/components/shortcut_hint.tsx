import type { ReactNode } from 'react';

import { useShortcutHintsVisible, useShortcutLabel } from '@/lib/keyboard_shortcuts';
import { cn } from '@/lib/utils';

import type { IKeyboardActionId } from '@shared/keybindings';

/** A key, as the shortcut list and hints show it. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      data-component="Kbd"
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line bg-key px-1.5 font-mono text-[11px] leading-none whitespace-nowrap text-white shadow-[0_1px_0_var(--color-key-edge)]',
        className
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * The action's key, shown over its control while Ctrl (Cmd on a Mac) is held.
 * The control positions it, and must be `relative`. Screen readers get the keys
 * from the control's `aria-keyshortcuts` instead.
 */
export function ShortcutHint({
  action,
  className,
}: {
  action: IKeyboardActionId;
  className?: string;
}) {
  const isVisible = useShortcutHintsVisible();
  const label = useShortcutLabel(action);
  if (!isVisible || !label) {
    return null;
  }
  return (
    <kbd
      data-component="ShortcutHint"
      aria-hidden
      className={cn(
        'pointer-events-none absolute z-20 inline-flex h-5 items-center rounded-md border border-cyan/60 bg-surface-plane px-1.5 font-mono text-[10px] leading-none font-semibold whitespace-nowrap text-cyan shadow-[0_2px_8px_rgb(0_0_0_/_0.6)]',
        className
      )}
    >
      {label}
    </kbd>
  );
}
