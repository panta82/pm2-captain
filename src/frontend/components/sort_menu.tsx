import { ArrowDownUp, ChevronDown, ChevronUp, RotateCw } from 'lucide-react';
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { type IProcessSort, type IProcessSortKey, chooseProcessSort } from '@/lib/process_sort';
import { useProcessTree } from '@/lib/process_tree';
import { cn } from '@/lib/utils';

import { STATS_COLUMNS } from './process_stats';

const VIEWPORT_MARGIN = 12;

const MENU_ITEMS: Array<{ key: IProcessSortKey; name: string }> = [
  { key: 'name', name: 'Name' },
  { key: 'status', name: 'Status' },
  ...STATS_COLUMNS.filter(column => column.key !== 'id').map(({ key, name }) => ({ key, name })),
  { key: 'id', name: 'PM2 ID' },
];

/** Shorter than the column headers: the button shares its row with the filter. */
const BUTTON_LABELS: Partial<Record<IProcessSortKey, string>> = {
  name: 'NAME',
  status: 'STATUS',
  id: 'ID',
  namespace: 'NS',
  mode: 'MODE',
  cpu: 'CPU',
  memory: 'MEM',
  uptime: 'UP',
  pid: 'PID',
  version: 'VER',
};

/** Orders the processes inside each daemon. The current order is on the button. */
export function SortMenu() {
  const { sort, setSort } = useProcessTree();
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentItem = MENU_ITEMS.find(item => item.key === sort?.key);

  // The menu is fixed so the overflow of the tree's column cannot cut it off.
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!isOpen || !trigger || !menu) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.max(VIEWPORT_MARGIN, rect.right - menu.offsetWidth)}px`;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    (
      menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      menuRef.current?.querySelector<HTMLElement>('button')
    )?.focus();
    const close = () => setIsOpen(false);
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', close);
    };
  }, [isOpen]);

  const closeAndRestoreFocus = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (next: IProcessSort | null) => {
    setSort(next);
    closeAndRestoreFocus();
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button'));
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex: number;
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      // Escape must not reach page-level handlers that leave the process view.
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    } else if (event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % items.length;
    } else if (event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = items.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  const direction = sort?.isDescending ? 'descending' : 'ascending';

  return (
    <div data-component="SortMenu" ref={rootRef} className="shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={
          currentItem ? `Sort processes: ${currentItem.name}, ${direction}` : 'Sort processes'
        }
        title="Sort the processes inside each daemon"
        className={cn(
          'flex h-9 items-center justify-center gap-1 rounded-lg border border-line font-mono text-[11px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan',
          sort
            ? 'bg-key-pressed px-2 text-key-pressed-ink shadow-[inset_0_2px_4px_rgb(0_0_0_/_0.42)] hover:bg-key'
            : 'w-9 bg-key text-control-muted shadow-[0_2px_0_var(--color-key-edge),inset_0_1px_0_rgb(255_255_255_/_0.06)] hover:bg-key-hover hover:text-white'
        )}
        onClick={() => setIsOpen(current => !current)}
      >
        {sort ? (
          <>
            {sort.key === 'restarts' ? (
              <RotateCw className="size-3" aria-hidden />
            ) : (
              BUTTON_LABELS[sort.key]
            )}
            {sort.isDescending ? (
              <ChevronDown className="size-3" aria-hidden />
            ) : (
              <ChevronUp className="size-3" aria-hidden />
            )}
          </>
        ) : (
          <ArrowDownUp className="size-3.5" aria-hidden />
        )}
      </button>
      {isOpen ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Sort processes"
          className="fixed z-40 w-48 overflow-hidden rounded-lg border border-line bg-surface-plane py-1 text-sm shadow-2xl"
          onKeyDown={handleMenuKeyDown}
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!sort}
            className={cn(
              'block h-8 w-full px-3 text-left hover:bg-panel focus-visible:bg-panel focus-visible:outline-none',
              sort ? 'text-control-muted' : 'text-cyan'
            )}
            onClick={() => choose(null)}
          >
            PM2 order
          </button>
          <div className="my-1 border-t border-line" />
          {MENU_ITEMS.map(item => {
            const isCurrent = sort?.key === item.key;
            return (
              <button
                key={item.key}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                className={cn(
                  'flex h-8 w-full items-center justify-between px-3 text-left hover:bg-panel focus-visible:bg-panel focus-visible:outline-none',
                  isCurrent ? 'text-cyan' : 'text-control-muted'
                )}
                onClick={() => choose(chooseProcessSort(sort, item.key))}
              >
                {item.name}
                {isCurrent ? (
                  sort.isDescending ? (
                    <ChevronDown className="size-3" aria-hidden />
                  ) : (
                    <ChevronUp className="size-3" aria-hidden />
                  )
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
