import { ChevronDown, ChevronUp, RotateCw } from 'lucide-react';
import { type ReactNode, memo } from 'react';

import type { IProcessSortKey } from '@/lib/process_sort';
import { useProcessTree } from '@/lib/process_tree';
import { cn, formatBytes, formatDuration } from '@/lib/utils';

import type { IProcessSummary } from '@shared/contracts';

import { Highlighted } from './highlighted';
import { ProcessActions } from './process_actions';

/**
 * The columns right of the tree. The header and every row use these tracks, so
 * they line up without measuring. Text columns share what is left over.
 */
export const STATS_GRID_CLASS =
  'grid min-w-0 flex-1 grid-cols-[minmax(3.5rem,0.5fr)_minmax(7rem,1fr)_minmax(4.75rem,0.7fr)_3rem_5.5rem_6.375rem_8.8125rem_minmax(4.75rem,0.7fr)_minmax(5.25rem,0.7fr)_14rem] items-center';

/** Past this width, the columns scroll under the tree. */
export const TREE_TABLE_WIDTH_CLASS = 'min-w-[calc(var(--sidebar-width)+63rem)]';

const CELL_CLASS = 'truncate px-4 first:pl-5';
const RESTARTS_CELL_CLASS = 'truncate px-1 text-center';

export const STATS_COLUMNS: Array<{
  key: IProcessSortKey;
  /** Accessible name and sort menu text. */
  name: string;
  /** Column header and sort button text. */
  label: string;
  header?: ReactNode;
}> = [
  { key: 'id', name: 'ID', label: 'ID' },
  { key: 'namespace', name: 'Namespace', label: 'NAMESPACE' },
  { key: 'mode', name: 'Mode', label: 'MODE' },
  {
    key: 'restarts',
    name: 'Restarts',
    label: 'RESTARTS',
    header: <RotateCw className="inline-block size-3" />,
  },
  { key: 'cpu', name: 'CPU', label: 'CPU' },
  { key: 'memory', name: 'Memory', label: 'MEM' },
  { key: 'uptime', name: 'Uptime', label: 'UPTIME' },
  { key: 'pid', name: 'PID', label: 'PID' },
  { key: 'version', name: 'Version', label: 'VERSION' },
];

/** Column headers beside the process filter. */
export function ProcessStatsHeader() {
  const { sort, cycleSort } = useProcessTree();

  return (
    <div
      data-component="ProcessStatsHeader"
      role="row"
      className={cn(
        'sticky top-0 z-20 flex h-detail-toolbar w-full border-b border-line bg-surface-control',
        TREE_TABLE_WIDTH_CLASS
      )}
    >
      <div className="sticky left-0 z-10 w-(--sidebar-width) shrink-0" />
      <div className={STATS_GRID_CLASS}>
        {STATS_COLUMNS.map(column => {
          const isSorted = sort?.key === column.key;
          const direction = sort?.isDescending ? 'descending' : 'ascending';
          return (
            <div
              key={column.key}
              role="columnheader"
              aria-sort={isSorted ? direction : undefined}
              className={cn(
                'text-[10px] font-semibold font-mono',
                column.key === 'restarts' ? RESTARTS_CELL_CLASS : CELL_CLASS,
                isSorted ? 'text-white' : 'text-muted'
              )}
            >
              <button
                type="button"
                aria-label={column.header ? column.name : undefined}
                className={cn(
                  'inline-flex items-center gap-1 hover:text-white',
                  column.header && 'relative justify-center'
                )}
                onClick={() => cycleSort(column.key)}
              >
                {column.header ?? column.label}
                {isSorted ? (
                  sort.isDescending ? (
                    <ChevronDown
                      className={cn(
                        'size-3 shrink-0',
                        column.header && 'absolute top-1/2 left-full ml-0.5 -translate-y-1/2'
                      )}
                    />
                  ) : (
                    <ChevronUp
                      className={cn(
                        'size-3 shrink-0',
                        column.header && 'absolute top-1/2 left-full ml-0.5 -translate-y-1/2'
                      )}
                    />
                  )
                ) : null}
              </button>
            </div>
          );
        })}
        <div role="columnheader" aria-label="Actions" />
      </div>
    </div>
  );
}

/** A process's cells, right of its name. */
export const ProcessStatCells = memo(function ProcessStatCells({
  process,
  highlight,
  isDaemonAvailable,
}: {
  process: IProcessSummary;
  highlight: RegExp | null;
  isDaemonAvailable: boolean;
}) {
  const faded = isDaemonAvailable ? undefined : 'opacity-55';

  return (
    <div
      data-component="ProcessStatCells"
      className={cn(STATS_GRID_CLASS, 'font-mono text-[13px] tabular-nums')}
    >
      <div role="cell" data-column="id" className={cn(CELL_CLASS, faded)}>
        <Highlighted text={String(process.pmId)} regex={highlight} />
      </div>
      <div role="cell" data-column="namespace" className={cn(CELL_CLASS, 'text-muted', faded)}>
        <Highlighted text={process.namespace} regex={highlight} />
      </div>
      <div role="cell" data-column="mode" className={cn(CELL_CLASS, faded)}>
        <Highlighted text={process.mode} regex={highlight} />
      </div>
      <div
        role="cell"
        data-column="restarts"
        className={cn(RESTARTS_CELL_CLASS, process.restarts > 10 && 'text-warning', faded)}
      >
        {process.restarts}
      </div>
      <div role="cell" data-column="cpu" className={cn(CELL_CLASS, 'text-cyan', faded)}>
        {process.cpu === null ? '—' : `${process.cpu.toFixed(1)}%`}
      </div>
      <div role="cell" data-column="memory" className={cn(CELL_CLASS, 'text-[#73a8ff]', faded)}>
        {formatBytes(process.memory)}
      </div>
      <div role="cell" data-column="uptime" className={cn(CELL_CLASS, faded)}>
        {formatDuration(process.uptime)}
      </div>
      <div role="cell" data-column="pid" className={cn(CELL_CLASS, faded)}>
        {process.pid ? <Highlighted text={String(process.pid)} regex={highlight} /> : '—'}
      </div>
      <div role="cell" data-column="version" className={cn(CELL_CLASS, faded)}>
        <Highlighted text={process.version || '—'} regex={highlight} />
      </div>
      <div role="cell" data-column="actions" className="px-3">
        <ProcessActions process={process} compact daemonAvailable={isDaemonAvailable} />
      </div>
    </div>
  );
});

/** Shows the current sort value beside each process when the columns are hidden. */
export function formatSortValue(process: IProcessSummary, key: IProcessSortKey): string | null {
  switch (key) {
    case 'name':
    case 'status':
      return null;
    case 'id':
      return String(process.pmId);
    case 'namespace':
      return process.namespace;
    case 'mode':
      return process.mode;
    case 'restarts':
      return String(process.restarts);
    case 'cpu':
      return process.cpu === null ? '—' : `${process.cpu.toFixed(1)}%`;
    case 'memory':
      return formatBytes(process.memory);
    case 'uptime':
      return formatDuration(process.uptime);
    case 'pid':
      return process.pid ? String(process.pid) : '—';
    case 'version':
      return process.version || '—';
  }
}
