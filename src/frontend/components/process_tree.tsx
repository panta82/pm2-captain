import { useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { Check, ChevronRight, Settings2 } from 'lucide-react';
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { focusProcessList, focusProcessPane, useShortcutHandler } from '@/lib/keyboard_shortcuts';
import { useProcessListFilter } from '@/lib/process_list_filter';
import { daemonLink, getProcessTab, namespaceLink, processLink } from '@/lib/process_route';
import { formatPmIds, selectRange, toggleSelection } from '@/lib/process_selection';
import { useProcessTree } from '@/lib/process_tree';
import {
  type IDaemonTreeRow,
  type INamespaceTreeRow,
  type IProcessTreeRow,
  type ITreeRow,
  daemonRowKey,
  namespaceRowKey,
  parentRowKey,
  processRowKey,
  sumProcesses,
} from '@/lib/process_tree_rows';
import { cn, formatBytes, isShown } from '@/lib/utils';

import type { IDaemonColor, IDaemonStatus, IProcessSummary } from '@shared/contracts';

import { DaemonRetryButton, isDaemonConnecting } from './daemon_actions';
import { useDaemonManager } from './daemon_manager';
import { DaemonStatusIcon, daemonColorStyle } from './daemon_option';
import { Highlighted } from './highlighted';
import { ProcessStack } from './process_stack';
import {
  ProcessStatCells,
  STATS_GRID_CLASS,
  TREE_TABLE_WIDTH_CLASS,
  formatSortValue,
} from './process_stats';
import { ProcessStatusDot } from './process_status_dot';

/**
 * The row the arrow keys move from, ringed while the tree has keyboard focus. The
 * ring is its own layer: the row's own outline would be under the sticky name cell.
 */
const CURSOR_CLASS =
  'relative after:pointer-events-none after:absolute after:inset-0 after:z-20 group-focus-visible/nav:after:outline-2 group-focus-visible/nav:after:-outline-offset-2 group-focus-visible/nav:after:outline-cyan/70';

const MOVE_DURATION_MS = 240;

/**
 * The tree's first column. As a table, it stays put while the columns scroll under
 * it. It has one width in both layouts, so nothing in it moves between them: the
 * side menu's scrollbar lies over the empty margin at the end of each row. Its
 * border is there only to take up the same room.
 */
const nameCellClass = (isTable: boolean) =>
  cn(
    'flex h-full w-(--sidebar-width) shrink-0 items-center border-r bg-inherit',
    isTable ? 'sticky left-0 z-10 border-line' : 'border-transparent'
  );

const rowClass = (isTable: boolean) =>
  cn(
    // The lines stay in the side menu too, so the column looks the same in both layouts.
    'group/row flex w-full shrink-0 cursor-pointer border-b border-line/70 [content-visibility:auto]',
    isTable && TREE_TABLE_WIDTH_CLASS
  );

/**
 * Every daemon and its processes. Next to an open process it is the side menu.
 * Without one, it is the table: each row goes on into the process's columns, so
 * the name, the tree and the row they belong to stay one element.
 */
export const ProcessTree = memo(function ProcessTree({
  isTable = false,
  autoFocus = false,
  onItemClick,
}: {
  isTable?: boolean;
  autoFocus?: boolean;
  onItemClick?: () => void;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const filter = useProcessListFilter();
  const {
    rows,
    highlight,
    sort,
    toggleDaemon,
    toggleNamespace,
    closeLink,
    focusedDaemonId,
    focusedNamespace,
    locationOf,
  } = useProcessTree();
  const routeDaemonId = useParams({ strict: false, select: params => params.daemonId });
  const routeTab = useParams({ strict: false, select: params => params.tab });
  const routePmIds = useParams({
    strict: false,
    select: params => params.pmIds,
    structuralSharing: true,
  });
  const selectedIds = useMemo(() => routePmIds ?? [], [routePmIds]);
  const isProcessOpen = selectedIds.length > 0;
  const isMulti = selectedIds.length > 1;
  const selectedDaemonId = isProcessOpen ? (routeDaemonId ?? null) : null;
  const selectionKey = formatPmIds(selectedIds);
  // A selection can be on Info while the remembered single-process tab is Logs.
  const linkTab = isProcessOpen && !isMulti && routeTab ? routeTab : getProcessTab();

  const navRef = useRef<HTMLElement>(null);
  const keepFocusRef = useRef(false);
  const anchorRef = useRef<number | null>(null);
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  // Rows picked in the table with Ctrl+click or Shift+click. They open together
  // once the key is let go, so the table stays until the picking is done.
  const [picked, setPicked] = useState<{ daemonId: string; pmIds: number[] } | null>(null);

  const processRows = rows.filter((row): row is IProcessTreeRow => row.kind === 'process');
  const isCursorListed = rows.some(row => row.key === cursorKey);
  const lastSelectedKey =
    selectedDaemonId && isProcessOpen
      ? processRowKey(selectedDaemonId, selectedIds[selectedIds.length - 1])
      : null;
  const isCursorSelected = processRows.some(
    row =>
      row.key === cursorKey &&
      row.process.daemonId === selectedDaemonId &&
      selectedIds.includes(row.process.pmId)
  );
  // With a process open, the cursor is always in the selection, which the arrows move.
  const activeKey = isProcessOpen
    ? isCursorSelected
      ? cursorKey
      : lastSelectedKey
    : isCursorListed
      ? cursorKey
      : null;

  const orderedIdsOf = (daemonId: string) =>
    processRows.filter(row => row.daemon.daemonId === daemonId).map(row => row.process.pmId);

  const getCursorPmId = () =>
    processRows.find(row => row.key === activeKey)?.process.pmId ??
    selectedIds[selectedIds.length - 1];

  const getAnchor = () =>
    anchorRef.current !== null && selectedIds.includes(anchorRef.current)
      ? anchorRef.current
      : getCursorPmId();

  const scrollToRow = (key: string | null) => {
    if (key) {
      navRef.current
        ?.querySelector(`[data-row-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  };

  const openSelection = (
    daemonId: string,
    pmIds: number[],
    cursorId: number,
    anchorId = getAnchor()
  ) => {
    setCursorKey(processRowKey(daemonId, cursorId));
    anchorRef.current = anchorId;
    keepFocusRef.current = true;
    if (pmIds.length) {
      void navigate(processLink(daemonId, pmIds));
    } else {
      void navigate(closeLink);
    }
  };

  const closeSelection = () => {
    setCursorKey(lastSelectedKey);
    keepFocusRef.current = true;
    void navigate(closeLink);
  };

  // The list is taller than its scroller, so a plain focus() would scroll to its
  // top, and away from the row that was just clicked.
  const focusTree = () => navRef.current?.focus({ preventScroll: true });

  const showDaemon = (daemonId: string) => {
    setCursorKey(daemonRowKey(daemonId));
    focusTree();
    void navigate(daemonLink(daemonId));
  };

  // Opening a process from anywhere leaves the keys here, on the list.
  useEffect(() => {
    if (autoFocus && isProcessOpen) {
      focusTree();
    }
  }, [autoFocus, isProcessOpen]);

  useEffect(() => {
    // A selection made here keeps the focus here. One made elsewhere, such as
    // with Ctrl+Down, only scrolls the list to it.
    const isOwnSelection = keepFocusRef.current;
    keepFocusRef.current = false;
    if (isOwnSelection) {
      focusTree();
    }
    scrollToRow(activeKey);
    // Only a changed selection moves the focus; the process list itself refreshes every 2 s.
  }, [selectedDaemonId, selectionKey]);

  // The scroll position as it was before a change shortens the list, which makes
  // the browser clamp it.
  const scrollTopRef = useRef(0);
  useEffect(() => {
    const scroller = navRef.current?.closest('[data-tree-scroller]');
    if (!scroller) {
      return;
    }
    const remember = () => {
      scrollTopRef.current = scroller.scrollTop;
    };
    remember();
    scroller.addEventListener('scroll', remember, { passive: true });
    return () => scroller.removeEventListener('scroll', remember);
  }, []);

  // When rows open or close around a daemon, that daemon's row keeps its place on
  // the screen. Rows that change places slide there, from where they were seen.
  // Rows are one element each, so moving one moves its name and its columns together.
  const rowOrder = rows.map(row => row.key).join(',');
  const positionsRef = useRef(new Map<string, number>());
  const anchorKeyRef = useRef<string | null>(null);
  const focusedKey =
    focusedDaemonId && focusedNamespace
      ? namespaceRowKey(focusedDaemonId, focusedNamespace)
      : focusedDaemonId
        ? daemonRowKey(focusedDaemonId)
        : null;
  const previousFocusRef = useRef(focusedKey);
  const previousSelectedKeyRef = useRef(lastSelectedKey);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const scroller = nav?.closest<HTMLElement>('[data-tree-scroller]');
    if (!nav || !scroller) {
      return;
    }
    // Focusing a daemon and leaving the focus both happen around that daemon,
    // whichever control asked for it.
    const previousFocus = previousFocusRef.current;
    previousFocusRef.current = focusedKey;
    const changedFocus = focusedKey !== previousFocus ? (focusedKey ?? previousFocus) : null;
    // A process that was closed stays where it was too, as everything opens around it.
    const closedSelectionKey = lastSelectedKey ? null : previousSelectedKeyRef.current;
    previousSelectedKeyRef.current = lastSelectedKey;
    const anchorKey = anchorKeyRef.current ?? changedFocus ?? closedSelectionKey;
    anchorKeyRef.current = null;

    const previousScrollTop = scrollTopRef.current;
    // Where a row is with the scroller at its top. The column headers are in the
    // scroller only as a table, and this counts the same in both layouts.
    const origin = scroller.getBoundingClientRect().top;
    const rowElements = Array.from(nav.querySelectorAll<HTMLElement>('[data-row-key]'));
    const positions = new Map(
      rowElements.map(row => [row.dataset.rowKey as string, origin + row.offsetTop])
    );

    const anchorRow = rowElements.find(row => row.dataset.rowKey === anchorKey);
    if (anchorKey && anchorRow) {
      const before = positionsRef.current.get(anchorKey);
      if (before !== undefined) {
        scroller.scrollTop = (positions.get(anchorKey) as number) - before + previousScrollTop;
      }
      // Its old place may not exist any more, or may be off screen to begin with.
      anchorRow.scrollIntoView({ block: 'nearest' });
    }
    const scrollShift = scroller.scrollTop - previousScrollTop;
    scrollTopRef.current = scroller.scrollTop;

    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const viewBottom = origin + scroller.clientHeight;
      for (const row of rowElements) {
        const key = row.dataset.rowKey as string;
        const before = positionsRef.current.get(key);
        const distance =
          before === undefined ? 0 : before - (positions.get(key) as number) + scrollShift;
        const top = (positions.get(key) as number) - scroller.scrollTop;
        // A live sort moves rows on every poll. Those whose whole path is out of
        // sight would cost frames, and a long list has many.
        const isPathHidden =
          Math.max(top, top + distance) + row.offsetHeight <= origin ||
          Math.min(top, top + distance) >= viewBottom;
        if (Math.abs(distance) >= 1 && !isPathHidden) {
          row.animate(
            [{ transform: `translateY(${distance}px)` }, { transform: 'translateY(0)' }],
            { duration: MOVE_DURATION_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }
          );
        }
      }
    }
    positionsRef.current = positions;
  }, [rowOrder, focusedKey, lastSelectedKey]);

  /** Opens or closes a daemon or namespace that was acted on, which keeps its place. */
  const toggleInPlace = (row: IDaemonTreeRow | INamespaceTreeRow) => {
    // A daemon with nothing to show changes no rows.
    if (row.processes.length) {
      anchorKeyRef.current = row.key;
    }
    if (row.kind === 'namespace') {
      toggleNamespace(row.daemon.daemonId, row.namespace);
    } else {
      toggleDaemon(row.daemon.daemonId);
    }
  };

  /**
   * A click on a daemon's or namespace's row, or Enter on it, always does both: it
   * selects it, which shows the table, and opens or closes it. Only the chevron
   * opens and closes it without selecting it.
   */
  const activateGroup = (row: IDaemonTreeRow | INamespaceTreeRow) => {
    const { daemonId } = row.daemon;
    const namespace = row.kind === 'namespace' ? row.namespace : null;
    setCursorKey(row.key);
    focusTree();
    toggleInPlace(row);
    if (isProcessOpen || focusedDaemonId !== daemonId || focusedNamespace !== namespace) {
      onItemClick?.();
      void navigate(namespace ? namespaceLink(daemonId, namespace) : daemonLink(daemonId));
    }
  };

  /**
   * A daemon's or namespace's check box selects every process it lists, next to
   * what is selected in the same daemon. With all of them selected, it lets them go.
   */
  const toggleGroupSelection = (row: IDaemonTreeRow | INamespaceTreeRow) => {
    const { daemonId } = row.daemon;
    const pmIds = row.listed.map(process => process.pmId);
    if (!pmIds.length) {
      return;
    }
    // One action request carries one daemon's connection, so a selection stays inside a daemon.
    const current = selectedDaemonId === daemonId ? selectedIds : [];
    const isAllSelected = pmIds.every(pmId => current.includes(pmId));
    const next = isAllSelected
      ? current.filter(pmId => !pmIds.includes(pmId))
      : [...current, ...pmIds.filter(pmId => !current.includes(pmId))];
    const cursorId = next.includes(pmIds[0]) ? pmIds[0] : (next.at(-1) ?? pmIds[0]);
    openSelection(daemonId, next, cursorId, cursorId);
  };

  useEffect(() => {
    if (!picked) {
      return;
    }
    const openPicked = (event: globalThis.KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      setPicked(null);
      keepFocusRef.current = true;
      void navigate(processLink(picked.daemonId, picked.pmIds));
    };
    // A key that is let go in another window never reports it here.
    const dropPicked = () => {
      anchorRef.current = null;
      setPicked(null);
    };
    window.addEventListener('keyup', openPicked);
    window.addEventListener('blur', dropPicked);
    return () => {
      window.removeEventListener('keyup', openPicked);
      window.removeEventListener('blur', dropPicked);
    };
  }, [navigate, picked]);

  /** Ctrl+click and Shift+click in the table, which only mark the rows for now. */
  const pickRow = (event: MouseEvent, daemonId: string, pmId: number) => {
    const current = picked?.daemonId === daemonId ? picked.pmIds : [];
    let pmIds: number[];
    if (event.shiftKey) {
      // The anchor of an earlier selection means nothing to a new round of picking.
      const anchorId = current.length && anchorRef.current !== null ? anchorRef.current : pmId;
      anchorRef.current = anchorId;
      const range = selectRange(orderedIdsOf(daemonId), anchorId, pmId);
      pmIds = event.ctrlKey || event.metaKey ? [...new Set([...current, ...range])] : range;
    } else {
      anchorRef.current = pmId;
      pmIds = toggleSelection(current, pmId);
    }
    setPicked(pmIds.length ? { daemonId, pmIds } : null);
  };

  const clickProcess = (event: MouseEvent<HTMLElement>, row: IProcessTreeRow) => {
    const { daemonId, pmId } = row.process;
    // One action request carries one daemon's connection, so a selection stays inside a daemon.
    const current = selectedDaemonId === daemonId ? selectedIds : [];
    if ((event.target as Element).closest('[data-tree-check]')) {
      openSelection(daemonId, toggleSelection(current, pmId), pmId, pmId);
      return;
    }
    if (event.button !== 0) {
      return;
    }
    const isAdding = event.ctrlKey || event.metaKey;
    if (event.shiftKey || isAdding) {
      event.preventDefault();
      if (!isProcessOpen) {
        pickRow(event, daemonId, pmId);
      } else if (event.shiftKey) {
        const anchorId = current.length ? getAnchor() : pmId;
        const range = selectRange(orderedIdsOf(daemonId), anchorId, pmId);
        openSelection(daemonId, isAdding ? [...current, ...range] : range, pmId, anchorId);
      } else {
        openSelection(daemonId, toggleSelection(current, pmId), pmId, pmId);
      }
      return;
    }
    if (event.altKey && (event.target as Element).closest('a')) {
      return;
    }
    event.preventDefault();
    onItemClick?.();
    anchorRef.current = pmId;
    setCursorKey(row.key);
    if (selectedDaemonId === daemonId && !isMulti && selectedIds[0] === pmId) {
      // The second click of a double-click must not close what the first one opened.
      if (event.detail <= 1) {
        closeSelection();
      }
      return;
    }
    keepFocusRef.current = true;
    void navigate(processLink(daemonId, [pmId], linkTab));
  };

  const clickGroup = (event: MouseEvent<HTMLElement>, row: IDaemonTreeRow | INamespaceTreeRow) => {
    const target = event.target as Element;
    if (target.closest('[data-tree-check]')) {
      toggleGroupSelection(row);
    } else if (target.closest('[data-tree-chevron]')) {
      toggleInPlace(row);
      focusTree();
    } else if (event.detail <= 1) {
      // The second click of a double-click must not undo what the first one did.
      activateGroup(row);
    }
  };

  // Handle clicks at the root so unchanged rows do not receive new closures
  // whenever another process is selected.
  const handleClick = (event: MouseEvent<HTMLElement>) => {
    if (!(event.target instanceof Element)) {
      return;
    }
    const key = event.target.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey;
    const row = rows.find(candidate => candidate.key === key);
    if (row?.kind === 'process') {
      clickProcess(event, row);
    } else if (row) {
      clickGroup(event, row);
    }
  };

  const moveCursor = (offset: 1 | -1, isExtending = false) => {
    if (isProcessOpen) {
      if (!processRows.length) {
        return;
      }
      const index = processRows.findIndex(row => row.key === activeKey);
      // A stale cursor enters the refreshed list at the top.
      const next =
        processRows[index < 0 ? 0 : Math.min(Math.max(index + offset, 0), processRows.length - 1)];
      if (next.key === activeKey) {
        return;
      }
      const { daemonId, pmId } = next.process;
      if (isExtending && daemonId === selectedDaemonId) {
        openSelection(daemonId, selectRange(orderedIdsOf(daemonId), getAnchor(), pmId), pmId);
      } else {
        openSelection(daemonId, [pmId], pmId, pmId);
      }
      return;
    }
    if (!rows.length) {
      return;
    }
    const index = rows.findIndex(row => row.key === activeKey);
    const next =
      index >= 0
        ? rows[Math.min(Math.max(index + offset, 0), rows.length - 1)]
        : ((offset > 0 ? processRows[0] : processRows.at(-1)) ?? rows[0]);
    setCursorKey(next.key);
    scrollToRow(next.key);
  };

  /** Left and Right, as in any tree. */
  const moveInTree = (isRight: boolean) => {
    const row = rows.find(candidate => candidate.key === activeKey);
    if (!row) {
      return;
    }
    if (row.kind !== 'process') {
      const child = rows[rows.indexOf(row) + 1];
      const isChild =
        row.kind === 'daemon'
          ? child && child.kind !== 'daemon'
          : child?.kind === 'process' && child.isGrouped;
      if (row.isOpen !== isRight) {
        toggleInPlace(row);
      } else if (isRight && isChild) {
        setCursorKey(child.key);
      } else if (!isRight && row.kind === 'namespace') {
        // A closed namespace goes up to its daemon.
        setCursorKey(daemonRowKey(row.daemon.daemonId));
        scrollToRow(daemonRowKey(row.daemon.daemonId));
      }
      return;
    }
    if (isRight) {
      return;
    }
    const parentKey = parentRowKey(row);
    if (isProcessOpen && row.isGrouped) {
      setCursorKey(parentKey);
      focusTree();
      void navigate(namespaceLink(row.daemon.daemonId, row.process.namespace));
    } else if (isProcessOpen) {
      showDaemon(row.daemon.daemonId);
    } else {
      setCursorKey(parentKey);
      scrollToRow(parentKey);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      // Escape clears the process filter first, then narrows a selection to one
      // process, closes that one, and then leaves a focused daemon.
      if (filter.search) {
        event.preventDefault();
        filter.setSearch('');
      } else if (isMulti && selectedDaemonId) {
        event.preventDefault();
        const pmId = getCursorPmId();
        openSelection(selectedDaemonId, [pmId], pmId, pmId);
      } else if (isProcessOpen) {
        event.preventDefault();
        closeSelection();
      } else if (focusedDaemonId && focusedNamespace) {
        event.preventDefault();
        void navigate(daemonLink(focusedDaemonId));
      } else if (focusedDaemonId) {
        event.preventDefault();
        void navigate({ to: '/' });
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      const row = rows.find(candidate => candidate.key === activeKey);
      const daemonId =
        selectedDaemonId ??
        (row ? row.daemon.daemonId : (focusedDaemonId ?? rows[0]?.daemon.daemonId));
      const pmIds = daemonId ? orderedIdsOf(daemonId) : [];
      if (daemonId && pmIds.length) {
        openSelection(
          daemonId,
          pmIds,
          selectedDaemonId ? getCursorPmId() : pmIds[0],
          selectedDaemonId ? getAnchor() : pmIds[0]
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
      if (isProcessOpen) {
        onItemClick?.();
        // Into the open process's tab, where the keys scroll it; Escape comes back.
        focusProcessPane();
        return;
      }
      const row = rows.find(candidate => candidate.key === activeKey);
      if (row?.kind === 'process') {
        openSelection(row.process.daemonId, [row.process.pmId], row.process.pmId, row.process.pmId);
      } else if (row) {
        activateGroup(row);
      }
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      moveInTree(event.key === 'ArrowRight');
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveCursor(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
    }
  };

  // Ctrl+Down and Ctrl+Up in the table go into the list, and then on through it.
  // With a process open, its page handles them.
  useShortcutHandler(
    ['process.next', 'process.previous'],
    actionId => {
      if (document.activeElement !== navRef.current) {
        return focusProcessList(actionId === 'process.previous');
      }
      moveCursor(actionId === 'process.next' ? 1 : -1);
    },
    !isProcessOpen
  );

  useShortcutHandler('daemon.picker', () => {
    const nav = navRef.current;
    if (!nav || !isShown(nav)) {
      return false;
    }
    focusTree();
    if (!isProcessOpen) {
      const target = focusedDaemonId
        ? daemonRowKey(focusedDaemonId)
        : rows.find(row => row.kind === 'daemon')?.key;
      setCursorKey(target ?? null);
      scrollToRow(target ?? null);
    }
  });

  const handleFocus = (event: FocusEvent<HTMLElement>) => {
    const nav = event.currentTarget;
    if (event.target !== nav) {
      return;
    }
    const enterFrom = nav.dataset.enterFrom;
    delete nav.dataset.enterFrom;
    if (isProcessOpen || (!enterFrom && activeKey)) {
      // Coming back to the list by keyboard shows where the keys are.
      if (enterFrom) {
        scrollToRow(activeKey);
      }
      return;
    }
    // The list starts at a process. The daemon above it is one step further.
    const entry =
      (enterFrom === 'end' ? processRows.at(-1) : processRows[0])?.key ?? rows[0]?.key ?? null;
    setCursorKey(entry);
    scrollToRow(entry);
  };

  // Each typed destination is independent of the current selection. Keep at most
  // three links per listed process, and discard them when the list changes.
  const processKey = processRows.map(row => row.key).join(',');
  const hrefs = useMemo(() => new Map<string, string>(), [router, processKey]);
  const hrefOf = (process: IProcessSummary) => {
    const key = `${process.daemonId}:${process.pmId}:${linkTab}`;
    let href = hrefs.get(key);
    if (href === undefined) {
      href = router.buildLocation(processLink(process.daemonId, [process.pmId], linkTab)).href;
      hrefs.set(key, href);
    }
    return href;
  };

  /** How much of what a daemon or namespace lists is selected. */
  const checkStateOf = (row: IDaemonTreeRow | INamespaceTreeRow): ICheckState => {
    if (selectedDaemonId !== row.daemon.daemonId || !row.listed.length) {
      return false;
    }
    const count = row.listed.filter(process => selectedIds.includes(process.pmId)).length;
    return count === row.listed.length ? true : count ? 'mixed' : false;
  };

  const renderRow = (row: ITreeRow) => {
    if (row.kind === 'daemon') {
      const { daemon } = row;
      const totals = sumProcesses(row.processes);
      return (
        <DaemonRow
          key={row.key}
          rowKey={row.key}
          daemonId={daemon.daemonId}
          label={daemon.label}
          color={daemon.color}
          status={daemon.status}
          error={daemon.error}
          location={locationOf(daemon.daemonId)}
          processes={row.processes}
          restarts={totals.restarts}
          cpu={totals.cpu}
          memory={totals.memory}
          isOpen={row.isOpen}
          isSelected={!isProcessOpen && focusedKey === row.key}
          holdsSelection={!row.isOpen && selectedDaemonId === daemon.daemonId}
          checkState={row.listed.length ? checkStateOf(row) : null}
          isCursor={activeKey === row.key}
          highlight={highlight}
          isTable={isTable}
        />
      );
    }
    if (row.kind === 'namespace') {
      const totals = sumProcesses(row.processes);
      const isHoldingSelection =
        !row.isOpen &&
        selectedDaemonId === row.daemon.daemonId &&
        row.processes.some(process => selectedIds.includes(process.pmId));
      return (
        <NamespaceRow
          key={row.key}
          rowKey={row.key}
          namespace={row.namespace}
          isDaemonAvailable={row.daemon.status === 'online'}
          processes={row.processes}
          restarts={totals.restarts}
          cpu={totals.cpu}
          memory={totals.memory}
          isOpen={row.isOpen}
          isSelected={!isProcessOpen && focusedKey === row.key}
          holdsSelection={isHoldingSelection}
          checkState={row.listed.length ? checkStateOf(row) : null}
          isCursor={activeKey === row.key}
          highlight={highlight}
          isTable={isTable}
        />
      );
    }
    const { daemon, process } = row;
    const isSelected = selectedDaemonId === daemon.daemonId && selectedIds.includes(process.pmId);
    return (
      <ProcessRow
        key={row.key}
        rowKey={row.key}
        process={process}
        isGrouped={row.isGrouped}
        color={daemon.color}
        isDaemonAvailable={daemon.status === 'online'}
        isSelected={isSelected}
        isOnlySelected={isSelected && !isMulti}
        isPicked={picked?.daemonId === daemon.daemonId && picked.pmIds.includes(process.pmId)}
        isCursor={activeKey === row.key}
        href={hrefOf(process)}
        highlight={highlight}
        isTable={isTable}
        sortValue={!isTable && sort ? formatSortValue(process, sort.key) : null}
        sortKey={sort?.key ?? null}
      />
    );
  };

  return (
    <nav
      data-component="ProcessTree"
      // PROCESS_LIST_ATTRIBUTE: Down in the process filter comes here.
      data-process-list
      ref={navRef}
      aria-label="Processes"
      // One tab stop for the whole tree; the arrow keys move within it.
      tabIndex={0}
      className={cn(
        'group/nav outline-none',
        isTable && 'flex min-h-[calc(100%-var(--height-detail-toolbar))] flex-col'
      )}
      // Shift+click would otherwise select the text between two processes.
      onMouseDown={event => {
        if (event.shiftKey) {
          event.preventDefault();
        }
      }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
    >
      <div role="treegrid" aria-label="Daemons and their processes" className="contents">
        {rows.map(renderRow)}
      </div>
      {/* The side menu's edge goes on past the last row. */}
      {isTable ? (
        <div className="sticky left-0 w-(--sidebar-width) flex-1 border-r border-line" />
      ) : null}
    </nav>
  );
});

const ProcessRow = memo(function ProcessRow({
  rowKey,
  process,
  isGrouped,
  color,
  isDaemonAvailable,
  isSelected,
  isOnlySelected,
  isPicked,
  isCursor,
  href,
  highlight,
  isTable,
  sortValue,
  sortKey,
}: {
  rowKey: string;
  process: IProcessSummary;
  isGrouped: boolean;
  color: IDaemonColor | null;
  isDaemonAvailable: boolean;
  isSelected: boolean;
  isOnlySelected: boolean;
  isPicked: boolean;
  isCursor: boolean;
  href: string;
  highlight: RegExp | null;
  isTable: boolean;
  sortValue: string | null;
  sortKey: string | null;
}) {
  const isOnline = process.status === 'online';
  const isChecked = isSelected || isPicked;

  return (
    <div
      data-component="ProcessRow"
      data-row-key={rowKey}
      data-tree-process
      data-cursor={isCursor || undefined}
      role="row"
      aria-level={isGrouped ? 3 : 2}
      aria-selected={isSelected}
      className={cn(
        rowClass(isTable),
        'h-12 items-center text-sm',
        isSelected
          ? 'bg-panel-hover text-white shadow-[inset_0_1px_0_rgb(255_255_255_/_0.07),inset_0_-1px_0_rgb(0_0_0_/_0.4)] hover:brightness-110'
          : isPicked
            ? 'bg-panel-hover text-white'
            : 'bg-surface-plane text-white/90 hover:bg-panel',
        isCursor && CURSOR_CLASS
      )}
    >
      <div role="cell" className={nameCellClass(isTable)}>
        <a
          href={href}
          aria-current={isOnlySelected ? 'page' : undefined}
          title={isOnlySelected ? 'Click to close' : undefined}
          tabIndex={-1}
          className={cn(
            'relative flex h-full min-w-0 flex-1 items-center gap-3 pr-3',
            isGrouped ? 'pl-[4.25rem]' : 'pl-11',
            // The line that ties the process to its daemon's chevron.
            'before:absolute before:inset-y-0 before:left-[1.6875rem] before:w-px',
            isSelected ? 'before:bg-white/15' : 'before:bg-line',
            // And the one that ties it to its namespace's.
            isGrouped && 'after:absolute after:inset-y-0 after:left-[3rem] after:w-px',
            isGrouped && (isSelected ? 'after:bg-white/15' : 'after:bg-line')
          )}
        >
          <ProcessStatusDot
            status={process.status}
            className={cn(!isDaemonAvailable && 'opacity-55')}
          />
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={cn('truncate font-semibold', !isDaemonAvailable && 'opacity-55')}
              style={daemonColorStyle(color)}
            >
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
          {sortValue !== null ? (
            <span
              className={cn(
                'shrink-0 font-mono text-xs tabular-nums',
                !isOnline || !isDaemonAvailable
                  ? 'text-muted'
                  : sortKey === 'cpu'
                    ? 'text-cyan'
                    : sortKey === 'memory'
                      ? 'text-[#73a8ff]'
                      : sortKey === 'restarts' && process.restarts > 10
                        ? 'text-warning'
                        : 'text-muted',
                !isDaemonAvailable && 'opacity-55'
              )}
            >
              {sortValue}
            </span>
          ) : null}
        </a>
        <TreeCheckbox state={isChecked} label={`Select ${process.name}`} className="mr-5" />
      </div>
      {isTable ? (
        <ProcessStatCells
          process={process}
          highlight={highlight}
          isDaemonAvailable={isDaemonAvailable}
        />
      ) : null}
    </div>
  );
});

/**
 * A named PM2 namespace inside a daemon. It groups the processes under it, and
 * sums them in the table, like a daemon does.
 */
const NamespaceRow = memo(function NamespaceRow({
  rowKey,
  namespace,
  isDaemonAvailable,
  processes,
  restarts,
  cpu,
  memory,
  isOpen,
  isSelected,
  holdsSelection,
  checkState,
  isCursor,
  highlight,
  isTable,
}: {
  rowKey: string;
  namespace: string;
  isDaemonAvailable: boolean;
  processes: IProcessSummary[];
  restarts: number;
  cpu: number;
  memory: number;
  isOpen: boolean;
  isSelected: boolean;
  holdsSelection: boolean;
  /** Null when it lists no process to select. */
  checkState: ICheckState | null;
  isCursor: boolean;
  highlight: RegExp | null;
  isTable: boolean;
}) {
  return (
    <div
      data-component="NamespaceRow"
      data-row-key={rowKey}
      data-tree-namespace
      data-cursor={isCursor || undefined}
      role="row"
      aria-level={2}
      aria-expanded={isOpen}
      aria-selected={isSelected}
      className={cn(
        rowClass(isTable),
        'h-9 items-center',
        isSelected
          ? 'bg-panel-hover text-white shadow-[inset_0_1px_0_rgb(255_255_255_/_0.07),inset_0_-1px_0_rgb(0_0_0_/_0.4)]'
          : 'bg-surface-plane text-muted hover:bg-panel hover:text-white',
        isCursor && CURSOR_CLASS
      )}
    >
      <div
        role="cell"
        className={cn(
          nameCellClass(isTable),
          'relative gap-2 pr-5',
          // The daemon's line goes on through its namespaces.
          'before:absolute before:inset-y-0 before:left-[1.6875rem] before:w-px before:bg-line',
          holdsSelection && 'shadow-[inset_2px_0_0_var(--color-cyan)]'
        )}
      >
        <button
          type="button"
          data-tree-chevron
          aria-label={`${isOpen ? 'Collapse' : 'Expand'} namespace ${namespace}`}
          tabIndex={-1}
          className="flex h-full w-[3.4375rem] shrink-0 items-center justify-end"
        >
          <ChevronRight
            className={cn('size-3.5 transition-transform duration-150', isOpen && 'rotate-90')}
          />
        </button>
        <span
          title={`Namespace ${namespace}`}
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-xs',
            !isDaemonAvailable && 'opacity-55'
          )}
        >
          <Highlighted text={namespace} regex={highlight} />
        </span>
        {isDaemonAvailable ? <ProcessStack processes={processes} /> : null}
        {checkState !== null ? (
          <TreeCheckbox state={checkState} label={`Select all in ${namespace}`} />
        ) : null}
      </div>
      {isTable ? (
        <div className={cn(STATS_GRID_CLASS, 'font-mono text-xs tabular-nums')}>
          {isDaemonAvailable ? (
            <>
              <div role="cell" className="col-span-3" />
              <div role="cell" className="truncate px-1 text-center">
                {restarts}
              </div>
              <div role="cell" className="truncate px-4 text-cyan/80">
                {cpu.toFixed(1)}%
              </div>
              <div role="cell" className="truncate px-4 text-[#73a8ff]/80">
                {formatBytes(memory)}
              </div>
              <div className="col-span-4" />
            </>
          ) : (
            <div className="col-span-10" />
          )}
        </div>
      ) : null}
    </div>
  );
});

const DaemonRow = memo(function DaemonRow({
  rowKey,
  daemonId,
  label,
  color,
  status,
  error,
  location,
  processes,
  restarts,
  cpu,
  memory,
  isOpen,
  isSelected,
  holdsSelection,
  checkState,
  isCursor,
  highlight,
  isTable,
}: {
  rowKey: string;
  daemonId: string;
  label: string;
  color: IDaemonColor | null;
  status: IDaemonStatus;
  error: string | null;
  location: string;
  processes: IProcessSummary[];
  restarts: number;
  cpu: number;
  memory: number;
  isOpen: boolean;
  isSelected: boolean;
  holdsSelection: boolean;
  /** Null when it lists no process to select. */
  checkState: ICheckState | null;
  isCursor: boolean;
  highlight: RegExp | null;
  isTable: boolean;
}) {
  const daemonManager = useDaemonManager();
  const isOnline = status === 'online';
  const isConnecting = isDaemonConnecting(status);

  return (
    <div
      data-component="DaemonRow"
      data-row-key={rowKey}
      data-tree-daemon
      data-cursor={isCursor || undefined}
      role="row"
      aria-level={1}
      aria-expanded={isOpen}
      aria-selected={isSelected}
      className={cn(
        rowClass(isTable),
        'h-10 items-center border-line',
        isSelected
          ? 'bg-panel-hover shadow-[inset_0_1px_0_rgb(255_255_255_/_0.07),inset_0_-1px_0_rgb(0_0_0_/_0.4)]'
          : 'bg-surface-control hover:bg-panel',
        isCursor && CURSOR_CLASS
      )}
    >
      <div
        role="cell"
        className={cn(
          nameCellClass(isTable),
          'gap-2 pr-5',
          holdsSelection && 'shadow-[inset_2px_0_0_var(--color-cyan)]'
        )}
      >
        <button
          type="button"
          data-tree-chevron
          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${label}`}
          tabIndex={-1}
          className="flex h-full w-[2.125rem] shrink-0 items-center pl-5 text-muted hover:text-white"
        >
          <ChevronRight
            className={cn('size-3.5 transition-transform duration-150', isOpen && 'rotate-90')}
          />
        </button>
        <DaemonStatusIcon status={status} color={color} />
        <button
          type="button"
          tabIndex={-1}
          title={label}
          className="min-w-0 flex-1 truncate text-left font-mono text-xs font-semibold text-white"
          style={daemonColorStyle(color)}
        >
          <Highlighted text={label} regex={highlight} />
        </button>
        {isOnline ? (
          <ProcessStack processes={processes} />
        ) : (
          <span
            className={cn(
              'shrink-0 font-mono text-[10px] uppercase',
              isConnecting ? 'text-warning' : 'text-danger'
            )}
          >
            {isConnecting ? 'connecting' : 'unreachable'}
          </span>
        )}
        {checkState !== null ? (
          <TreeCheckbox state={checkState} label={`Select all in ${label}`} />
        ) : null}
      </div>
      {isTable ? (
        <div className={cn(STATS_GRID_CLASS, 'font-mono text-xs tabular-nums')}>
          {isOnline ? (
            <>
              <div
                role="cell"
                title={location}
                className="col-span-3 truncate pr-4 pl-5 text-muted"
              >
                {location}
              </div>
              <div role="cell" className="truncate px-1 text-center">
                {restarts}
              </div>
              <div role="cell" className="truncate px-4 text-cyan">
                {cpu.toFixed(1)}%
              </div>
              <div role="cell" className="truncate px-4 text-[#73a8ff]">
                {formatBytes(memory)}
              </div>
              <div className="col-span-3" />
            </>
          ) : (
            <div
              role="cell"
              title={isConnecting ? undefined : (error ?? undefined)}
              className={cn(
                'col-span-9 truncate pr-4 pl-5',
                isConnecting ? 'text-warning' : 'text-danger'
              )}
            >
              {isConnecting
                ? `${status === 'reconnecting' ? 'Reconnecting' : 'Connecting'} to ${label}…`
                : error || 'Unable to connect to the PM2 daemon.'}
            </div>
          )}
          <div role="cell" className="flex items-center justify-end gap-2 px-3 font-sans">
            {!isOnline && !isConnecting ? <DaemonRetryButton daemonId={daemonId} /> : null}
            <button
              type="button"
              aria-label={`Edit ${label}`}
              title={`Edit ${label}`}
              className="grid size-7 place-items-center rounded-md text-muted opacity-0 group-hover/row:opacity-100 hover:bg-white/10 hover:text-white focus-visible:opacity-100"
              onClick={event => {
                event.stopPropagation();
                daemonManager.open('daemon', daemonId);
              }}
            >
              <Settings2 className="size-3.5" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
});

/** Checked, unchecked, or partly checked for a daemon or namespace with some of its processes selected. */
type ICheckState = boolean | 'mixed';

/** A row's check box. The tree handles its clicks, by the row it is in. */
function TreeCheckbox({
  state,
  label,
  className,
}: {
  state: ICheckState;
  label: string;
  className?: string;
}) {
  return (
    <button
      data-component="TreeCheckbox"
      type="button"
      role="checkbox"
      data-tree-check
      aria-checked={state}
      aria-label={label}
      tabIndex={-1}
      className={cn(
        'group/check grid size-[18px] shrink-0 place-items-center rounded-[4px] border border-line hover:border-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan',
        state === true && 'bg-surface-control text-control-muted',
        className
      )}
    >
      {state === 'mixed' ? (
        // Filled with the border's own color, which it follows on hover.
        <i className="size-2 rounded-[2px] bg-line group-hover/check:bg-muted" />
      ) : state ? (
        <Check className="size-3" strokeWidth={2} />
      ) : null}
    </button>
  );
}
