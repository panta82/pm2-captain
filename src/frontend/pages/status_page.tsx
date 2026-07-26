import { useNavigate } from '@tanstack/react-router';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { ChevronDown, ChevronUp, Eye, RotateCw } from 'lucide-react';
import { useState } from 'react';

import { processDetailTo } from '@/lib/process_tab';
import { trpc } from '@/lib/trpc';
import { cn, formatBytes, formatDuration } from '@/lib/utils';

import { ProcessActions } from '@/components/process_actions';
import { Skeleton } from '@/components/ui';

import type { IProcessSummary } from '@shared/contracts';

const column = createColumnHelper<IProcessSummary>();

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

export function StatusPage() {
  const navigate = useNavigate();
  const [sorting, setSorting] = useState<SortingState>([]);
  const query = trpc.processes.list.useQuery(undefined, {
    refetchInterval: 2_000,
  });
  const columns = [
    column.accessor('pmId', {
      header: 'ID',
      cell: info => info.getValue(),
    }),
    column.accessor('name', {
      header: 'NAME',
      cell: info => (
        <div className="flex items-center gap-2">
          <i
            className={cn(
              'size-2 shrink-0 rounded-full',
              info.row.original.status === 'online'
                ? 'bg-online shadow-[0_0_9px_#35D07F]'
                : 'border border-muted'
            )}
          />
          <span className="font-sans font-semibold text-white">{info.getValue()}</span>
          {info.row.original.isCaptain ? (
            <span className="rounded border border-cyan/60 px-1.5 py-0.5 font-mono text-[9px] text-cyan">
              YOU
            </span>
          ) : null}
        </div>
      ),
    }),
    column.accessor('mode', { header: 'MODE' }),
    column.accessor('restarts', {
      header: () => <RotateCw className="inline-block size-3" />,
      cell: info => (
        <span className={info.getValue() > 10 ? 'text-warning' : ''}>{info.getValue()}</span>
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
        <span className="text-cyan">
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
      cell: info => <span className="text-[#73a8ff]">{formatBytes(info.getValue())}</span>,
    }),
    column.accessor('uptime', {
      header: 'UPTIME',
      sortingFn: (left, right, columnId) =>
        compareNullableNumber(
          left.getValue<number | null>(columnId),
          right.getValue<number | null>(columnId)
        ),
      cell: info => formatDuration(info.getValue()),
    }),
    column.accessor('pid', {
      header: 'PID',
      sortingFn: (left, right, columnId) =>
        compareNullableNumber(
          left.getValue<number | null>(columnId),
          right.getValue<number | null>(columnId)
        ),
      cell: info => info.getValue() || '—',
    }),
    column.accessor('version', {
      header: 'VERSION',
      cell: info => info.getValue() || '—',
    }),
    column.accessor('watching', {
      header: 'WATCH',
      cell: info => (
        <span className={info.getValue() ? 'text-online' : 'text-muted'}>
          {info.getValue() ? '✓' : '×'}
        </span>
      ),
    }),
    column.display({
      id: 'actions',
      header: '',
      enableSorting: false,
      cell: info => <ProcessActions process={info.row.original} compact />,
    }),
  ];
  const table = useReactTable({
    data: query.data?.processes || [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

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
      <div data-component="StatusPage" className="grid flex-1 place-items-center p-10 text-center">
        <div>
          <p className="font-semibold text-danger">Unable to reach PM2</p>
          <p className="mt-2 max-w-lg text-sm text-muted">{query.error.message}</p>
        </div>
      </div>
    );
  }

  return (
    <main data-component="StatusPage" className="flex-1 overflow-auto">
      <div className="hidden min-w-[1100px] lg:block">
        <table className="w-full border-collapse font-mono text-[13px]">
          <thead>
            {table.getHeaderGroups().map(group => (
              <tr key={group.id} className="h-11 border-b border-line bg-topbar/70">
                {group.headers.map(header => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  const isCentered =
                    header.column.id === 'restarts' || header.column.id === 'watching';
                  return (
                    <th
                      key={header.id}
                      className={cn(
                        'px-4 text-[10px] font-semibold first:pl-6',
                        isCentered ? 'text-center' : 'text-left',
                        sorted ? 'text-white' : 'text-muted'
                      )}
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          className={cn(
                            'inline-flex items-center gap-1 transition-colors hover:text-white',
                            isCentered && 'justify-center'
                          )}
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                          {sorted === 'asc' ? (
                            <ChevronUp className="size-3 shrink-0" />
                          ) : sorted === 'desc' ? (
                            <ChevronDown className="size-3 shrink-0" />
                          ) : (
                            <span className="size-3 shrink-0" aria-hidden />
                          )}
                        </button>
                      ) : (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map(row => (
              <tr
                key={row.id}
                tabIndex={0}
                className="h-[54px] cursor-pointer border-b border-line/70 bg-panel/45 transition-colors hover:bg-panel-hover focus:bg-panel-hover focus:outline-none"
                onClick={() =>
                  navigate({
                    to: processDetailTo(),
                    params: { pmId: String(row.original.pmId) },
                  })
                }
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    navigate({
                      to: processDetailTo(),
                      params: { pmId: String(row.original.pmId) },
                    });
                  }
                }}
              >
                {row.getVisibleCells().map(cell => (
                  <td
                    key={cell.id}
                    className={cn(
                      'px-4 first:pl-6',
                      (cell.column.id === 'restarts' || cell.column.id === 'watching') &&
                        'text-center'
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 p-3 lg:hidden">
        {query.data?.processes.map(process => (
          <article key={process.pmId} className="rounded-xl border border-line bg-panel p-4">
            <button
              className="block w-full text-left"
              onClick={() =>
                navigate({
                  to: processDetailTo(),
                  params: { pmId: String(process.pmId) },
                })
              }
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-white">{process.name}</span>
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
                <ProcessActions process={process} compact />
                <button
                  aria-label={`Open ${process.name}`}
                  onClick={() =>
                    navigate({
                      to: processDetailTo(),
                      params: { pmId: String(process.pmId) },
                    })
                  }
                >
                  <Eye className="size-4 text-cyan" />
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
