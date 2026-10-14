import { useNavigate, useRouter } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, memo, useEffect, useMemo, useRef } from 'react';

import { type ProcessTab, processLink } from '@/lib/process_route';
import { formatPmIds, selectRange, toggleSelection } from '@/lib/process_selection';
import { cn } from '@/lib/utils';

import { Highlighted } from '@/components/highlighted';

import type { IProcessSummary } from '@shared/contracts';

export const ProcessNav = memo(
  function ProcessNav({
    processes,
    highlight = null,
    selectedDaemonId,
    selectedIds,
    tab,
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
    tab: ProcessTab;
    className?: string;
    itemClassName?: string;
    selectedItemClassName?: string;
    idleItemClassName?: string;
    onItemClick?: () => void;
    autoFocus?: boolean;
  }) {
    const navigate = useNavigate();
    // The router itself, unlike `Link`, does not subscribe this list to location changes.
    const router = useRouter();
    const processKey = processes.map(process => `${process.daemonId}:${process.pmId}`).join(',');
    // Each typed destination is independent of the current selection. Keep at
    // most three links per listed process, and discard them when the list changes.
    const hrefs = useMemo(() => new Map<string, string>(), [router, processKey]);
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
      void navigate(processLink(selectedDaemonId, pmIds));
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

    // Handle selection at the nav root so unchanged rows do not receive new
    // closures whenever another process is selected.
    const handleClick = (event: MouseEvent<HTMLElement>) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const row = event.target.closest<HTMLElement>('[data-pm-id]');
      const control = event.target.closest('a,button');
      const process = processes.find(process => process.pmId === Number(row?.dataset.pmId));
      if (!process || !control) {
        return;
      }
      if (control.tagName === 'BUTTON') {
        openSelection(toggleSelection(selectedIds, process.pmId), process.pmId, process.pmId);
        return;
      }
      if (event.button !== 0) {
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        const range = selectRange(orderedIds(), getAnchor(), process.pmId);
        openSelection(
          event.ctrlKey || event.metaKey ? [...selectedIds, ...range] : range,
          process.pmId
        );
      } else if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        openSelection(toggleSelection(selectedIds, process.pmId), process.pmId, process.pmId);
      } else {
        cursorRef.current = process.pmId;
        anchorRef.current = process.pmId;
        onItemClick?.();
        if (event.altKey) {
          return;
        }
        event.preventDefault();
        void navigate(processLink(process.daemonId, [process.pmId], tab));
      }
    };

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
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        {processes.map(process => {
          const isSelected =
            process.daemonId === selectedDaemonId && selectedIds.includes(process.pmId);
          const hrefKey = `${process.daemonId}:${process.pmId}:${tab}`;
          let href = hrefs.get(hrefKey);
          if (href === undefined) {
            href = router.buildLocation(processLink(process.daemonId, [process.pmId], tab)).href;
            hrefs.set(hrefKey, href);
          }
          return (
            <ProcessNavRow
              key={`${process.daemonId}:${process.pmId}`}
              pmId={process.pmId}
              name={process.name}
              status={process.status}
              isCaptain={process.isCaptain}
              isSelected={isSelected}
              isMulti={isMulti}
              href={href}
              highlight={highlight}
              className={cn(itemClassName, isSelected ? selectedItemClassName : idleItemClassName)}
            />
          );
        })}
      </nav>
    );
  },
  (previous, next) => {
    const {
      processes: previousProcesses,
      highlight: previousHighlight,
      ...previousProps
    } = previous;
    const { processes: nextProcesses, highlight: nextHighlight, ...nextProps } = next;
    const keys = Object.keys(previousProps) as Array<keyof typeof previousProps>;
    if (
      keys.length !== Object.keys(nextProps).length ||
      keys.some(key => previousProps[key] !== nextProps[key]) ||
      previousHighlight?.source !== nextHighlight?.source ||
      previousHighlight?.flags !== nextHighlight?.flags
    ) {
      return false;
    }
    // CPU, memory and uptime change on each poll, but the sidebar displays none
    // of them. Preserve its rows and typed links until their visible fields change.
    return (
      previousProcesses.length === nextProcesses.length &&
      previousProcesses.every((process, index) => {
        const candidate = nextProcesses[index];
        return (
          process.daemonId === candidate.daemonId &&
          process.pmId === candidate.pmId &&
          process.name === candidate.name &&
          process.status === candidate.status &&
          process.isCaptain === candidate.isCaptain
        );
      })
    );
  }
);

const ProcessNavRow = memo(function ProcessNavRow({
  pmId,
  name,
  status,
  isCaptain,
  isSelected,
  isMulti,
  href,
  highlight,
  className,
}: {
  pmId: number;
  name: string;
  status: IProcessSummary['status'];
  isCaptain: boolean;
  isSelected: boolean;
  isMulti: boolean;
  href: string;
  highlight: RegExp | null;
  className: string;
}) {
  // A tab changes the href, but can reuse the status, label and logo tree.
  const label = useMemo(
    () => (
      <>
        <i
          className={cn(
            'size-2 shrink-0 rounded-full',
            status === 'online' ? 'bg-online shadow-[0_0_9px_#35D07F]' : 'border border-muted'
          )}
        />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate font-semibold">
            <Highlighted text={name} regex={highlight} />
          </span>
          {isCaptain ? (
            <img
              src="/pm2-captain-logo-on-dark.png"
              alt="Captain"
              title="This is Captain"
              className="size-3.5 shrink-0 object-contain"
            />
          ) : null}
        </span>
      </>
    ),
    [status, name, highlight, isCaptain]
  );
  return (
    <div
      data-component="ProcessNavRow"
      data-pm-id={pmId}
      className={cn('[content-visibility:auto]', className)}
    >
      <a
        href={href}
        aria-current={isSelected && !isMulti ? 'page' : undefined}
        className="flex h-full min-w-0 flex-1 items-center gap-3 pr-3 pl-5"
      >
        {label}
      </a>
      <button
        type="button"
        role="checkbox"
        aria-checked={isSelected}
        aria-label={`Select ${name}`}
        className={cn(
          'mr-5 grid size-[18px] shrink-0 place-items-center rounded-[4px] border border-line hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan',
          isSelected && 'bg-surface-control text-control-muted'
        )}
      >
        {isSelected ? <Check className="size-3" strokeWidth={2} /> : null}
      </button>
    </div>
  );
});
