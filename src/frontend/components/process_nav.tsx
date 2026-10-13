import { Link, useNavigate } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef } from 'react';

import { formatPmIds, selectRange, toggleSelection } from '@/lib/process_selection';
import { processDetailTo, selectionDetailTo } from '@/lib/process_tab';
import { cn } from '@/lib/utils';

import { Highlighted } from '@/components/highlighted';

import type { IProcessSummary } from '@shared/contracts';

export function ProcessNav({
  processes,
  highlight = null,
  selectedDaemonId,
  selectedIds,
  className,
  itemClassName,
  selectedItemClassName,
  idleItemClassName,
  onItemClick,
  autoFocus = false,
}: {
  processes: IProcessSummary[];
  highlight?: RegExp | null;
  selectedDaemonId: string;
  /** One process, or several after Ctrl+click and Shift+click. */
  selectedIds: number[];
  className?: string;
  itemClassName?: string;
  selectedItemClassName?: string;
  idleItemClassName?: string;
  onItemClick?: () => void;
  autoFocus?: boolean;
}) {
  const navigate = useNavigate();
  const navRef = useRef<HTMLElement>(null);
  const keepFocusRef = useRef(false);
  const didAutoFocusRef = useRef(false);
  const isMulti = selectedIds.length > 1;
  const selectionKey = formatPmIds(selectedIds);
  // The cursor is where the arrow keys move from, the anchor where a Shift range
  // starts. A selection that came from the URL has neither, so they fall back to
  // a process that is in it.
  const cursorRef = useRef<number | null>(null);
  const anchorRef = useRef<number | null>(null);
  const getCursor = () =>
    cursorRef.current !== null && selectedIds.includes(cursorRef.current)
      ? cursorRef.current
      : selectedIds[selectedIds.length - 1];
  const getAnchor = () =>
    anchorRef.current !== null && selectedIds.includes(anchorRef.current)
      ? anchorRef.current
      : getCursor();

  const openSelection = (pmIds: number[], cursorId: number, anchorId = getAnchor()) => {
    cursorRef.current = cursorId;
    anchorRef.current = anchorId;
    keepFocusRef.current = true;
    void navigate({
      to: selectionDetailTo(pmIds.length),
      params: { daemonId: selectedDaemonId, pmId: formatPmIds(pmIds) },
    });
  };

  useEffect(() => {
    if (!autoFocus || didAutoFocusRef.current) {
      return;
    }
    didAutoFocusRef.current = true;
    navRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!keepFocusRef.current) {
      return;
    }
    keepFocusRef.current = false;
    navRef.current?.focus();
    const cursorIndex = processes.findIndex(process => process.pmId === cursorRef.current);
    navRef.current?.children[cursorIndex]?.scrollIntoView({ block: 'nearest' });
    // Only a changed selection moves the focus; the process list itself refreshes every 2 s.
  }, [selectedDaemonId, selectionKey]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // The first Escape narrows a selection to one process, the next one leaves.
      if (isMulti) {
        openSelection([getCursor()], getCursor(), getCursor());
      } else {
        void navigate({ to: '/' });
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      if (processes.length) {
        openSelection(
          processes.map(process => process.pmId),
          getCursor()
        );
      }
      return;
    }
    if (event.key === 'Enter') {
      // Enter on a check box toggles it, like Space does.
      if (event.target instanceof HTMLButtonElement) {
        return;
      }
      event.preventDefault();
      onItemClick?.();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    if (!processes.length) {
      return;
    }
    const cursorId = getCursor();
    const currentIndex = processes.findIndex(
      process => process.daemonId === selectedDaemonId && process.pmId === cursorId
    );
    // A filter can hide the open process; the arrows then enter the list at the top.
    const nextIndex =
      currentIndex < 0
        ? 0
        : event.key === 'ArrowDown'
          ? Math.min(currentIndex + 1, processes.length - 1)
          : Math.max(currentIndex - 1, 0);
    if (nextIndex === currentIndex) {
      return;
    }
    const nextId = processes[nextIndex].pmId;
    if (event.shiftKey) {
      openSelection(selectRange(orderedIds(), getAnchor(), nextId), nextId);
    } else {
      openSelection([nextId], nextId, nextId);
    }
  };

  const orderedIds = () => processes.map(process => process.pmId);

  return (
    <nav
      data-component="ProcessNav"
      ref={navRef}
      aria-label="Processes"
      tabIndex={0}
      className={cn('outline-none', className)}
      // Shift+click would otherwise select the text between two processes.
      onMouseDown={event => {
        if (event.shiftKey) {
          event.preventDefault();
        }
      }}
      onKeyDown={handleKeyDown}
    >
      {processes.map(process => {
        const isSelected =
          process.daemonId === selectedDaemonId && selectedIds.includes(process.pmId);
        return (
          <div
            key={`${process.daemonId}:${process.pmId}`}
            className={cn(itemClassName, isSelected ? selectedItemClassName : idleItemClassName)}
          >
            <Link
              to={processDetailTo()}
              params={{ daemonId: process.daemonId, pmId: String(process.pmId) }}
              onClick={event => {
                if (event.shiftKey) {
                  event.preventDefault();
                  const range = selectRange(orderedIds(), getAnchor(), process.pmId);
                  openSelection(
                    event.ctrlKey || event.metaKey ? [...selectedIds, ...range] : range,
                    process.pmId
                  );
                } else if (event.ctrlKey || event.metaKey) {
                  event.preventDefault();
                  openSelection(
                    toggleSelection(selectedIds, process.pmId),
                    process.pmId,
                    process.pmId
                  );
                } else {
                  cursorRef.current = process.pmId;
                  anchorRef.current = process.pmId;
                  onItemClick?.();
                }
              }}
              className="flex h-full min-w-0 flex-1 items-center gap-3 pr-3 pl-5"
            >
              <i
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  process.status === 'online'
                    ? 'bg-online shadow-[0_0_9px_#35D07F]'
                    : 'border border-muted'
                )}
              />
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate font-semibold">
                  <Highlighted text={process.name} regex={highlight} />
                </span>
                {process.isCaptain ? (
                  <img
                    src="/pm2-captain-logo-on-dark.png"
                    alt="Captain"
                    title="This is Captain"
                    className="size-3.5 shrink-0 object-contain"
                  />
                ) : null}
              </span>
            </Link>
            {/* Does what Ctrl+click does, also where there is no Ctrl key. */}
            <button
              type="button"
              role="checkbox"
              aria-checked={isSelected}
              aria-label={`Select ${process.name}`}
              className={cn(
                'mr-5 grid size-[18px] shrink-0 place-items-center rounded-[4px] border border-line hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan',
                // A well with a check in it, not a filled accent: the row is already lit.
                isSelected && 'bg-surface-control text-control-muted'
              )}
              onClick={() =>
                openSelection(
                  toggleSelection(selectedIds, process.pmId),
                  process.pmId,
                  process.pmId
                )
              }
            >
              {isSelected ? <Check className="size-3" strokeWidth={2} /> : null}
            </button>
          </div>
        );
      })}
    </nav>
  );
}
