import { ChevronDown, Settings2 } from 'lucide-react';
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useDaemonSelection } from '@/lib/daemon_selection';
import { cn } from '@/lib/utils';

import type { IProcessListResult } from '@shared/contracts';

import { useDaemonManager } from './daemon_manager';
import { DAEMON_OPTION_LIST_CLASS, DaemonOption, DaemonStatusIcon } from './daemon_option';

const VIEWPORT_MARGIN = 12;

export function DaemonPicker({
  data,
  className,
}: {
  data: IProcessListResult;
  className?: string;
}) {
  const { daemons, processes } = data;
  const { selectedDaemonId, selectDaemon } = useDaemonSelection();
  const daemonManager = useDaemonManager();
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedDaemon = daemons.find(daemon => daemon.daemonId === selectedDaemonId);

  // The menu is fixed so the sidebar's overflow clipping cannot cut it off.
  // Keep it under the trigger, at least as wide, and inside the viewport.
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!isOpen || !trigger || !menu) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    menu.style.minWidth = `${rect.width}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - menu.offsetWidth - VIEWPORT_MARGIN)
    )}px`;
  }, [isOpen, data]);

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

  return (
    <div data-component="DaemonPicker" ref={rootRef} className={cn('min-w-0', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={selectedDaemon ? `Daemon: ${selectedDaemon.label}` : 'Daemon'}
        title={selectedDaemon?.label}
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-line bg-input px-2.5 font-mono text-xs text-white hover:bg-input-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan aria-expanded:border-cyan/60 aria-expanded:bg-input-focus"
        onClick={() => setIsOpen(current => !current)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setIsOpen(true);
          }
        }}
      >
        {selectedDaemon ? <DaemonStatusIcon status={selectedDaemon.status} /> : null}
        <span className={cn('min-w-0 flex-1 truncate text-left', !selectedDaemon && 'text-muted')}>
          {selectedDaemon?.label ?? 'No daemons'}
        </span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 text-muted', isOpen && 'rotate-180')}
          aria-hidden
        />
      </button>
      {isOpen ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Daemons"
          className={cn(
            DAEMON_OPTION_LIST_CLASS,
            'fixed z-30 max-w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-line bg-surface-plane py-1 shadow-2xl'
          )}
          onKeyDown={handleMenuKeyDown}
        >
          {daemons.map(daemon => (
            <DaemonOption
              key={daemon.daemonId}
              role="menuitemradio"
              aria-checked={daemon.daemonId === selectedDaemonId}
              daemon={daemon}
              processes={processes}
              isSelected={daemon.daemonId === selectedDaemonId}
              onClick={() => {
                closeAndRestoreFocus();
                selectDaemon(daemon.daemonId);
              }}
            />
          ))}
          <button
            type="button"
            role="menuitem"
            className={cn(
              'col-span-full flex items-center gap-2.5 px-3 py-2 text-left font-mono text-xs text-control-muted hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan/60',
              daemons.length && 'mt-1 border-t border-line pt-2.5'
            )}
            onClick={() => {
              setIsOpen(false);
              daemonManager.open();
            }}
          >
            <Settings2 className="size-3.5 shrink-0" aria-hidden />
            Manage daemons…
          </button>
        </div>
      ) : null}
    </div>
  );
}
