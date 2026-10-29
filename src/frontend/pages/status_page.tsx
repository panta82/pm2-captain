import { useNavigate } from '@tanstack/react-router';
import {
  type SortingState,
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { ChevronDown, ChevronUp, Eye, LoaderCircle, Plus, RotateCw, Server } from 'lucide-react';
import { type MouseEvent, startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useDaemonSelection } from '@/lib/daemon_selection';
import { useShortcutHandler } from '@/lib/keyboard_shortcuts';
import { useFilteredProcesses, useProcessListFilter } from '@/lib/process_list_filter';
import { processLink } from '@/lib/process_route';
import { selectRange } from '@/lib/process_selection';
import { trpc } from '@/lib/trpc';
import { cn, formatBytes, formatDuration } from '@/lib/utils';

import { useDaemonManager } from '@/components/daemon_manager';
import { daemonColorStyle } from '@/components/daemon_option';
import { ErrorPanel } from '@/components/error_panel';
import { Highlighted } from '@/components/highlighted';
import { ProcessActions } from '@/components/process_actions';
import { Button, Skeleton } from '@/components/ui';

import type { IDaemonSummary, IProcessSummary } from '@shared/contracts';

const column = createColumnHelper<IProcessSummary>();
const coreRowModel = getCoreRowModel();
const sortedRowModel = getSortedRowModel();

const STABLE_COLUMN_CLASS: Record<string, string> = {
  namespace: 'whitespace-nowrap',
  mode: 'whitespace-nowrap',
  restarts: 'w-12 min-w-12 px-1 text-center tabular-nums',
  cpu: 'w-[calc(6ch+2rem)] min-w-[calc(6ch+2rem)] whitespace-nowrap tabular-nums',
  memory: 'w-[calc(8ch+2rem)] min-w-[calc(8ch+2rem)] whitespace-nowrap tabular-nums',
  uptime: 'w-[calc(13ch+2rem)] min-w-[calc(13ch+2rem)] whitespace-nowrap tabular-nums',
  pid: 'whitespace-nowrap tabular-nums',
  version: 'whitespace-nowrap',
};

function compareNullableNumber(
  left: number | null | undefined,
  right: number | null | undefined
): number {
  if (left == null && right == null) {
    return 0;
  }
  if (left == null) {
    return 1;
  }
  if (right == null) {
    return -1;
  }
  return left - right;
}

function useIsDesktopTable(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : true
  );

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const onChange = () => setIsDesktop(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return isDesktop;
}

function DaemonUnavailable({ daemon }: { daemon: IDaemonSummary }) {
  const utils = trpc.useUtils();
  const daemonManager = useDaemonManager();
  const retry = trpc.daemons.retry.useMutation({
    onSuccess: () => utils.processes.list.invalidate(),
    onError: error => toast.error(error.message),
  });

  if (daemon.status === 'connecting' || daemon.status === 'reconnecting') {
    return (
      <div
        data-component="DaemonUnavailable"
        className="grid min-h-0 flex-1 place-items-center px-5 py-12"
      >
        <p className="flex items-center gap-3 font-mono text-sm text-muted">
          <LoaderCircle className="size-4 shrink-0 animate-spin text-cyan" />
          Connecting to {daemon.label}…
        </p>
      </div>
    );
  }

  return (
    <div data-component="DaemonUnavailable" className="flex min-h-0 flex-1 flex-col">
      <ErrorPanel
        title={`Can't reach ${daemon.label}`}
        message={daemon.error || 'Unable to connect to the PM2 daemon.'}
      >
        <Button
          variant="primary"
          disabled={retry.isPending}
          onClick={() => retry.mutate({ daemonId: daemon.daemonId })}
        >
          {retry.isPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <RotateCw className="size-4" />
          )}
          Try again
        </Button>
        <Button onClick={() => daemonManager.open()}>Manage daemons</Button>
      </ErrorPanel>
    </div>
  );
}

function NoDaemons() {
  const daemonManager = useDaemonManager();

  return (
    <div data-component="NoDaemons" className="grid min-h-0 flex-1 place-items-center px-5 py-12">
      <section className="w-full max-w-md rounded-2xl border border-line bg-panel p-7 text-center">
        <Server className="mx-auto size-9 text-muted" aria-hidden />
        <h1 className="mt-4 text-2xl font-bold text-white">No PM2 daemons</h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          Add a PM2 daemon on this computer or on a server reached over SSH.
        </p>
        <div className="mt-6 flex justify-center">
          <Button variant="primary" onClick={() => daemonManager.open('add')}>
            <Plus className="size-4" />
            Add daemon
          </Button>
        </div>
      </section>
    </div>
  );
}

export function StatusPage() {
  const navigate = useNavigate();
  const processFilter = useProcessListFilter();
  const { selectedDaemonId } = useDaemonSelection();
  const isDesktopTable = useIsDesktopTable();
  const [sorting, setSorting] = useState<SortingState>([]);
  // Rows picked with Ctrl+click or Shift+click. They open together once the key is let go.
  const [pickedIds, setPickedIds] = useState<number[]>([]);
  const pickAnchorRef = useRef<number | null>(null);
  const tableBodyRef = useRef<HTMLTableSectionElement>(null);
  const query = trpc.processes.list.useQuery(undefined, {
    refetchInterval: 2_000,
  });
  const selectedDaemon = query.data?.daemons.find(daemon => daemon.daemonId === selectedDaemonId);
  const isDaemonAvailable = selectedDaemon?.status === 'online';
  const daemonColor = selectedDaemon?.color ?? null;
  const daemonProcesses = useMemo(
    () => (query.data?.processes || []).filter(process => process.daemonId === selectedDaemonId),
    [query.data?.processes, selectedDaemonId]
  );

  const filterResult = useFilteredProcesses(daemonProcesses);

  const columns = useMemo(
    () => [
      column.accessor('pmId', {
        header: 'ID',
        cell: info => <Highlighted text={String(info.getValue())} regex={filterResult.highlight} />,
      }),
      column.accessor('name', {
        header: 'NAME',
        cell: info => (
          <div className="flex min-w-0 items-center gap-2">
            <i
              className={cn(
                'size-2 shrink-0 rounded-full',
                info.row.original.status === 'online'
                  ? 'bg-online shadow-[0_0_9px_#35D07F]'
                  : 'border border-muted'
              )}
            />
            <span
              className="truncate font-sans font-semibold text-white"
              style={daemonColorStyle(daemonColor)}
            >
              <Highlighted text={info.getValue()} regex={filterResult.highlight} />
            </span>
            {info.row.original.isCaptain ? (
              <img
                src="/pm2-captain-logo-on-dark.png"
                alt="Captain"
                title="This is Captain"
                className="size-3.5 shrink-0 object-contain"
              />
            ) : null}
          </div>
        ),
      }),
      column.accessor('namespace', {
        header: 'NAMESPACE',
        cell: info => (
          <span className="text-muted">
            <Highlighted text={info.getValue()} regex={filterResult.highlight} />
          </span>
        ),
      }),
      column.accessor('mode', {
        header: 'MODE',
        cell: info => <Highlighted text={info.getValue()} regex={filterResult.highlight} />,
      }),
      column.accessor('restarts', {
        header: () => <RotateCw className="inline-block size-3" />,
        cell: info => (
          <span className={cn('tabular-nums', info.getValue() > 10 && 'text-warning')}>
            {info.getValue()}
          </span>
        ),
      }),
      column.accessor('cpu', {
        header: 'CPU',
        sortingFn: (left, right, columnId) =>
          compareNullableNumber(
            left.getValue<number | null>(columnId),
            right.getValue<number | null>(columnId)
          ),
        cell: info => (
          <span className="text-cyan tabular-nums">
            {info.getValue() === null ? '—' : `${info.getValue()!.toFixed(1)}%`}
          </span>
        ),
      }),
      column.accessor('memory', {
        header: 'MEM',
        sortingFn: (left, right, columnId) =>
          compareNullableNumber(
            left.getValue<number | null>(columnId),
            right.getValue<number | null>(columnId)
          ),
        cell: info => (
          <span className="text-[#73a8ff] tabular-nums">{formatBytes(info.getValue())}</span>
        ),
      }),
      column.accessor('uptime', {
        header: 'UPTIME',
        sortingFn: (left, right, columnId) =>
          compareNullableNumber(
            left.getValue<number | null>(columnId),
            right.getValue<number | null>(columnId)
          ),
        cell: info => <span className="tabular-nums">{formatDuration(info.getValue())}</span>,
      }),
      column.accessor('pid', {
        header: 'PID',
        sortingFn: (left, right, columnId) =>
          compareNullableNumber(
            left.getValue<number | null>(columnId),
            right.getValue<number | null>(columnId)
          ),
        cell: info => {
          const pid = info.getValue();
          if (!pid) {
            return '—';
          }
          return <Highlighted text={String(pid)} regex={filterResult.highlight} />;
        },
      }),
      column.accessor('version', {
        header: 'VERSION',
        cell: info => {
          const version = info.getValue() || '—';
          return <Highlighted text={version} regex={filterResult.highlight} />;
        },
      }),
      column.display({
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: info => (
          <ProcessActions process={info.row.original} compact daemonAvailable={isDaemonAvailable} />
        ),
      }),
    ],
    [filterResult.highlight, isDaemonAvailable, daemonColor]
  );

  const table = useReactTable({
    data: filterResult.processes,
    columns,
    state: { sorting },
    onSortingChange: updater => {
      startTransition(() => {
        setSorting(updater);
      });
    },
    getRowId: row => `${row.daemonId}:${row.pmId}`,
    getCoreRowModel: coreRowModel,
    getSortedRowModel: sortedRowModel,
  });

  useEffect(() => {
    if (!pickedIds.length || !selectedDaemonId) {
      return;
    }
    const openPicked = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      void navigate(processLink(selectedDaemonId, pickedIds));
    };
    // A key that is let go in another window never reports it here.
    const dropPicked = () => {
      pickAnchorRef.current = null;
      setPickedIds([]);
    };
    window.addEventListener('keyup', openPicked);
    window.addEventListener('blur', dropPicked);
    return () => {
      window.removeEventListener('keyup', openPicked);
      window.removeEventListener('blur', dropPicked);
    };
  }, [navigate, pickedIds, selectedDaemonId]);

  /** Moves the focus to the next or previous row; Enter opens it. */
  const focusRow = (offset: 1 | -1) => {
    const rows = Array.from(
      tableBodyRef.current?.querySelectorAll<HTMLElement>('tr[tabindex]') ?? []
    );
    if (!rows.length) {
      return false;
    }
    const current = rows.findIndex(row => row === document.activeElement);
    // Without a focused row, the first step lands on the first or the last one.
    const next = current < 0 ? (offset > 0 ? 0 : rows.length - 1) : current + offset;
    const row = rows[Math.min(Math.max(next, 0), rows.length - 1)];
    row.focus();
    row.scrollIntoView({ block: 'nearest' });
    return true;
  };
  useShortcutHandler(['process.next', 'process.previous'], actionId =>
    focusRow(actionId === 'process.next' ? 1 : -1)
  );

  // PM2 IDs repeat across daemons, so rows picked on one daemon mean nothing on the next.
  useEffect(() => {
    pickAnchorRef.current = null;
    setPickedIds([]);
  }, [selectedDaemonId]);

  const pickRow = (event: MouseEvent, pmId: number) => {
    const isAdding = event.ctrlKey || event.metaKey;
    if (event.shiftKey) {
      const anchorId = pickAnchorRef.current ?? pmId;
      pickAnchorRef.current = anchorId;
      const range = selectRange(
        table.getRowModel().rows.map(row => row.original.pmId),
        anchorId,
        pmId
      );
      setPickedIds(current => (isAdding ? [...new Set([...current, ...range])] : range));
    } else {
      pickAnchorRef.current = pmId;
      setPickedIds(current =>
        current.includes(pmId) ? current.filter(id => id !== pmId) : [...current, pmId]
      );
    }
  };

  if (query.isLoading) {
    return (
      <div data-component="StatusPage" className="space-y-px p-4">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (query.error) {
    return (
      <div data-component="StatusPage" className="flex min-h-0 flex-1 flex-col">
        <ErrorPanel title="Unable to reach PM2" message={query.error.message}>
          <Button variant="primary" onClick={() => void query.refetch()}>
            <RotateCw className="size-4" />
            Try again
          </Button>
        </ErrorPanel>
      </div>
    );
  }

  // Stale processes stay listed while their daemon is unreachable; without any,
  // the daemon's own state is the only useful thing to show.
  if (query.data && !query.data.daemons.length) {
    return <NoDaemons />;
  }

  if (selectedDaemon && !isDaemonAvailable && !daemonProcesses.length) {
    return <DaemonUnavailable daemon={selectedDaemon} />;
  }

  return (
    <main data-component="StatusPage" className="flex-1 overflow-auto">
      {filterResult.error ? (
        <div className="border-b border-line px-4 py-2 font-mono text-xs text-danger sm:px-6">
          {filterResult.error}
        </div>
      ) : null}
      {selectedDaemon && !isDaemonAvailable ? (
        <div className="border-b border-warning/30 bg-warning/5 px-4 py-2 font-mono text-xs text-warning sm:px-6">
          {selectedDaemon.status === 'connecting' || selectedDaemon.status === 'reconnecting'
            ? `Reconnecting to ${selectedDaemon.label}…`
            : `${selectedDaemon.label}: ${selectedDaemon.error || 'Unable to connect'}`}
        </div>
      ) : null}
      {isDesktopTable ? (
        <div className="min-w-[1100px]">
          <table className="w-full border-collapse font-mono text-[13px]">
            <thead>
              {table.getHeaderGroups().map(group => (
                <tr key={group.id} className="h-11 border-b border-line bg-surface-control">
                  {group.headers.map(header => {
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    const isCentered = header.column.id === 'restarts';
                    return (
                      <th
                        key={header.id}
                        className={cn(
                          'px-4 text-left text-[10px] font-semibold first:pl-6',
                          STABLE_COLUMN_CLASS[header.column.id],
                          sorted ? 'text-white' : 'text-muted'
                        )}
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            className={cn(
                              'inline-flex items-center gap-1 hover:text-white',
                              isCentered && 'relative justify-center'
                            )}
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === 'asc' ? (
                              <ChevronUp
                                className={cn(
                                  'size-3 shrink-0',
                                  isCentered && 'absolute top-1/2 left-full ml-0.5 -translate-y-1/2'
                                )}
                              />
                            ) : sorted === 'desc' ? (
                              <ChevronDown
                                className={cn(
                                  'size-3 shrink-0',
                                  isCentered && 'absolute top-1/2 left-full ml-0.5 -translate-y-1/2'
                                )}
                              />
                            ) : isCentered ? null : (
                              <span className="size-3 shrink-0" aria-hidden />
                            )}
                          </button>
                        ) : (
                          flexRender(header.column.columnDef.header, header.getContext())
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody ref={tableBodyRef} data-process-list>
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="px-6 py-10 text-center font-mono text-sm text-muted"
                  >
                    {processFilter.search
                      ? 'No processes match the filter.'
                      : 'No PM2 processes found.'}
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map(row => (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    className={cn(
                      'h-[54px] cursor-pointer border-b border-line/70 hover:bg-panel focus:bg-panel focus:outline-none row-focus-ring',
                      pickedIds.includes(row.original.pmId) && 'bg-panel-hover hover:bg-panel-hover'
                    )}
                    // Shift+click would otherwise select the text between two rows.
                    onMouseDown={event => {
                      if (event.shiftKey) {
                        event.preventDefault();
                      }
                    }}
                    onClick={event => {
                      if (event.ctrlKey || event.metaKey || event.shiftKey) {
                        pickRow(event, row.original.pmId);
                        return;
                      }
                      void navigate(processLink(row.original.daemonId, [row.original.pmId]));
                    }}
                    onKeyDown={event => {
                      if (event.target !== event.currentTarget) {
                        return;
                      }
                      if (event.key === 'Enter') {
                        navigate(processLink(row.original.daemonId, [row.original.pmId]));
                      } else if (
                        (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
                        !event.altKey &&
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.shiftKey
                      ) {
                        event.preventDefault();
                        focusRow(event.key === 'ArrowDown' ? 1 : -1);
                      }
                    }}
                  >
                    {row.getVisibleCells().map(cell => (
                      <td
                        key={cell.id}
                        className={cn('px-4 first:pl-6', STABLE_COLUMN_CLASS[cell.column.id])}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid gap-3 p-3" data-process-list>
          {filterResult.processes.length === 0 ? (
            <div className="rounded-xl border border-line bg-panel px-4 py-8 text-center font-mono text-sm text-muted">
              {processFilter.search ? 'No processes match the filter.' : 'No PM2 processes found.'}
            </div>
          ) : (
            filterResult.processes.map(process => (
              <article
                key={`${process.daemonId}:${process.pmId}`}
                className="rounded-xl border border-line bg-panel p-4"
              >
                <button
                  className="block w-full text-left"
                  onClick={() => navigate(processLink(process.daemonId, [process.pmId]))}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className="font-semibold text-white"
                      style={daemonColorStyle(daemonColor)}
                    >
                      <Highlighted text={process.name} regex={filterResult.highlight} />
                    </span>
                    <span
                      className={cn(
                        'rounded-full border px-2 py-1 font-mono text-[10px] uppercase',
                        process.status === 'online'
                          ? 'border-online/40 bg-online/10 text-online'
                          : 'border-muted/30 text-muted'
                      )}
                    >
                      {process.status}
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-3 font-mono text-xs text-muted">
                    <span>
                      CPU <b className="block pt-1 text-cyan">{process.cpu?.toFixed(1) || '—'}%</b>
                    </span>
                    <span>
                      MEM <b className="block pt-1 text-white">{formatBytes(process.memory)}</b>
                    </span>
                    <span>
                      UP <b className="block pt-1 text-online">{formatDuration(process.uptime)}</b>
                    </span>
                  </div>
                </button>
                <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
                  <span className="font-mono text-xs text-muted">
                    id {process.pmId} · pid {process.pid || '—'}
                  </span>
                  <div className="flex items-center gap-3">
                    <ProcessActions process={process} compact daemonAvailable={isDaemonAvailable} />
                    <button
                      aria-label={`Open ${process.name}`}
                      onClick={() => navigate(processLink(process.daemonId, [process.pmId]))}
                    >
                      <Eye className="size-4 text-cyan" />
                    </button>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      )}
    </main>
  );
}
