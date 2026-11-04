import { Link, useRouterState } from '@tanstack/react-router';
import { ChevronsDownUp, ChevronsUpDown, ServerCog, ShieldCheck } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';

import { readPreference, writePreference } from '@/lib/preferences';
import { useProcessListFilter } from '@/lib/process_list_filter';
import { useProcessTree } from '@/lib/process_tree';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import { useDaemonManager } from './daemon_manager';
import { ProcessFilterField } from './process_filter_field';
import { ProcessStack } from './process_stack';
import { ProcessStatsHeader } from './process_stats';
import { ProcessTree } from './process_tree';
import { ShortcutHint } from './shortcut_hint';
import { SortMenu } from './sort_menu';
import { Button } from './ui';

const SIDEBAR_WIDTH_KEY = 'pm2-captain:process-sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 232;
const MAX_SIDEBAR_WIDTH = 480;

function constrainWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function loadSidebarWidth(): number {
  const storedWidth = Number(readPreference(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(storedWidth) && storedWidth > 0
    ? constrainWidth(storedWidth)
    : DEFAULT_SIDEBAR_WIDTH;
}

/** Whether the viewport can show the tree beside the content. */
export function useIsWideLayout(): boolean {
  const [isWide, setIsWide] = useState(() => window.matchMedia('(min-width: 1024px)').matches);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const onChange = () => setIsWide(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return isWide;
}

/**
 * Clicking Captain shows all processes and toggles every daemon. If any daemon
 * is collapsed, the first click expands them all.
 */
function CaptainNode({ isSelected }: { isSelected: boolean }) {
  const { isEveryDaemonOpen, setAllDaemonsOpen } = useProcessTree();
  const ToggleIcon = isEveryDaemonOpen ? ChevronsDownUp : ChevronsUpDown;

  return (
    <header
      data-component="CaptainNode"
      className={cn(
        'col-start-1 row-start-1 flex min-w-0 border-r border-b border-line',
        isSelected
          ? 'bg-panel-hover shadow-[inset_0_1px_0_rgb(255_255_255_/_0.07),inset_0_-1px_0_rgb(0_0_0_/_0.4)]'
          : 'bg-surface-menu hover:bg-panel'
      )}
    >
      <Link
        to="/"
        aria-label="PM2 Captain"
        title={isEveryDaemonOpen ? 'Collapse all daemons' : 'Expand all daemons'}
        className="relative flex min-w-0 flex-1 items-center gap-3 pr-4 pl-5 hover:brightness-125 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan"
        onClick={() => setAllDaemonsOpen(!isEveryDaemonOpen)}
      >
        <CaptainLogo />
        <span className="min-w-0 flex-1 truncate text-lg font-bold">
          <span className="text-white">PM2 </span>
          <span className="text-cyan">Captain</span>
        </span>
        <ToggleIcon aria-hidden className="size-3.5 shrink-0 text-muted" />
        <ShortcutHint action="daemon.picker" className="top-1/2 right-9 -translate-y-1/2" />
      </Link>
    </header>
  );
}

export function CaptainLogo() {
  return (
    <div data-component="CaptainLogo" className="relative grid size-8 shrink-0 place-items-center">
      <img
        src="/pm2-captain-logo-on-dark.png"
        alt=""
        className="size-8 object-contain"
        onError={event => {
          event.currentTarget.style.display = 'none';
          event.currentTarget.nextElementSibling?.classList.remove('hidden');
        }}
      />
      <ShieldCheck className="hidden size-7 text-cyan" aria-hidden="true" />
    </div>
  );
}

/** Opens the daemon settings: add, edit and remove daemons. */
export function DaemonsButton({ isCompact = false }: { isCompact?: boolean }) {
  const daemonManager = useDaemonManager();

  return (
    <Button
      data-component="DaemonsButton"
      aria-label="Daemons"
      title="Add, edit and remove daemons"
      className={cn('shrink-0', isCompact && 'size-10 p-0')}
      onClick={() => daemonManager.open()}
    >
      <ServerCog className="size-4" />
      {isCompact ? null : 'Daemons'}
    </Button>
  );
}

/** The window's top row on a narrow screen, where Captain has no column of its own. */
export function NarrowHeader() {
  const { data } = useProcessTree();

  return (
    <header
      data-component="NarrowHeader"
      className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface-menu px-3"
    >
      <Link
        to="/"
        aria-label="PM2 Captain"
        className="flex min-w-0 items-center gap-3 rounded-md hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        <CaptainLogo />
        <span className="hidden whitespace-nowrap text-lg font-bold sm:block">
          <span className="text-white">PM2 </span>
          <span className="text-cyan">Captain</span>
        </span>
      </Link>
      <ProcessStack processes={data?.processes ?? []} className="ml-auto" />
      <DaemonsButton isCompact />
    </header>
  );
}

/** The filter and the sort button, above the tree. */
export function ProcessTreeTools({ className }: { className?: string }) {
  return (
    <div
      data-component="ProcessTreeTools"
      className={cn('flex min-w-0 items-center gap-2', className)}
    >
      <ProcessFilterField className="flex-1" />
      <SortMenu />
    </div>
  );
}

/** A reason the list is empty, or a filter that cannot run. */
export function ProcessListNotice({ className }: { className?: string }) {
  const { data, rows, filterError } = useProcessTree();
  const filter = useProcessListFilter();
  const notice =
    filterError || (data && filter.search && !rows.length ? 'No processes match the filter.' : '');
  if (!notice) {
    return null;
  }
  return (
    <p
      data-component="ProcessListNotice"
      className={cn('font-mono text-xs', filterError ? 'text-danger' : 'text-muted', className)}
    >
      {notice}
    </p>
  );
}

/**
 * The tree with its tools. The tools and the tree keep their place while the
 * rest of the window changes around them. As a table, one scroller holds the
 * column headers and the rows, so the two can never drift apart.
 */
function ProcessTreeArea({ isTable }: { isTable: boolean }) {
  return (
    <div
      data-component="ProcessTreeArea"
      className={cn(
        'relative row-start-2 min-h-0 min-w-0',
        isTable ? 'col-span-2 col-start-1' : 'col-start-1'
      )}
    >
      <ProcessTreeTools className="absolute top-0 left-0 z-30 h-detail-toolbar w-(--sidebar-width) border-r border-b border-line bg-surface-control px-3" />
      <div
        data-tree-scroller
        className={cn(
          // The tree keeps rows in place itself, including while a live sort moves them.
          'absolute inset-x-0 bottom-0 bg-surface-plane [overflow-anchor:none]',
          isTable
            ? // A row brought into view stops below the sticky column headers.
              'top-0 scroll-pt-(--height-detail-toolbar) overflow-auto'
            : 'top-(--height-detail-toolbar) overflow-x-hidden overflow-y-auto overscroll-contain border-r border-line'
        )}
      >
        {isTable ? <ProcessStatsHeader /> : null}
        <ProcessListNotice className="sticky left-0 w-(--sidebar-width) px-5 py-3" />
        <ProcessTree isTable={isTable} autoFocus />
      </div>
    </div>
  );
}

function SidebarResizeHandle({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (width: number) => void;
}) {
  const widthRef = useRef(width);
  widthRef.current = width;
  const resizeRef = useRef<{ pointerX: number; width: number } | null>(null);
  const previousBodyStylesRef = useRef<{ cursor: string; userSelect: string } | null>(null);

  const restoreBodyStyles = () => {
    if (!previousBodyStylesRef.current) {
      return;
    }
    document.body.style.cursor = previousBodyStylesRef.current.cursor;
    document.body.style.userSelect = previousBodyStylesRef.current.userSelect;
    previousBodyStylesRef.current = null;
  };

  const finishResize = () => {
    if (!resizeRef.current) {
      return;
    }
    resizeRef.current = null;
    writePreference(SIDEBAR_WIDTH_KEY, String(widthRef.current));
    restoreBodyStyles();
  };

  useEffect(() => restoreBodyStyles, []);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeRef.current = { pointerX: event.clientX, width: widthRef.current };
    previousBodyStylesRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current) {
      onWidthChange(
        constrainWidth(resizeRef.current.width + event.clientX - resizeRef.current.pointerX)
      );
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const next = constrainWidth(widthRef.current + (event.key === 'ArrowRight' ? 16 : -16));
    onWidthChange(next);
    writePreference(SIDEBAR_WIDTH_KEY, String(next));
  };

  return (
    <div
      data-component="SidebarResizeHandle"
      role="separator"
      aria-label="Resize process sidebar"
      aria-orientation="vertical"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize the process sidebar"
      className="absolute inset-y-0 left-[calc(var(--sidebar-width)-0.25rem)] z-40 w-1 cursor-col-resize touch-none bg-transparent outline-none transition-colors hover:bg-cyan/55 focus-visible:bg-cyan/75"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
      onLostPointerCapture={finishResize}
      onKeyDown={handleKeyDown}
    />
  );
}

/**
 * One layout for everything: Captain, the tools and the tree on the left, the
 * selected thing's page on the right. Without a selected process, the page is
 * only its top band, and the tree's rows go on into the columns underneath it.
 */
export function Workspace({ children }: { children: ReactNode }) {
  const isWide = useIsWideLayout();
  const list = trpc.processes.list.useQuery(undefined, { refetchInterval: 2_000 });
  const { focusedDaemonId } = useProcessTree();
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const routeId = useRouterState({ select: state => state.matches.at(-1)?.routeId });
  const isOverview =
    routeId === '/' ||
    routeId === '/daemons/$daemonId' ||
    routeId === '/daemons/$daemonId/namespaces/$namespace';
  // A page of its own explains an empty or failed list, next to the tree.
  const isTable = isWide && isOverview && !list.error && Boolean(list.data?.daemons.length);
  const isRootSelected = isOverview && !focusedDaemonId;

  return (
    <div
      data-component="Workspace"
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
      className={
        isWide
          ? 'relative grid min-h-0 flex-1 grid-cols-[var(--sidebar-width)_minmax(0,1fr)] grid-rows-[4rem_minmax(0,1fr)]'
          : 'flex min-h-0 flex-1 flex-col'
      }
    >
      {isWide ? <CaptainNode isSelected={isRootSelected} /> : null}
      {isWide ? <ProcessTreeArea isTable={isTable} /> : null}
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-col',
          isWide ? 'col-start-2 row-start-1' : 'flex-1',
          isWide && !isTable && 'row-span-2'
        )}
      >
        {children}
      </div>
      {isWide ? <SidebarResizeHandle width={sidebarWidth} onWidthChange={setSidebarWidth} /> : null}
    </div>
  );
}
