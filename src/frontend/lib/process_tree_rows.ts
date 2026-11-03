import { type IProcessSort, sortProcesses } from '@/lib/process_sort';

import type { IDaemonSummary, IProcessSummary } from '@shared/contracts';

/** A daemon row with all its processes, including those hidden by the filter. */
export interface IDaemonTreeRow {
  kind: 'daemon';
  key: string;
  daemon: IDaemonSummary;
  processes: IProcessSummary[];
  isOpen: boolean;
}

export interface IProcessTreeRow {
  kind: 'process';
  key: string;
  daemon: IDaemonSummary;
  process: IProcessSummary;
}

export type ITreeRow = IDaemonTreeRow | IProcessTreeRow;

export const daemonRowKey = (daemonId: string) => `daemon:${daemonId}`;
export const processRowKey = (daemonId: string, pmId: number) => `process:${daemonId}:${pmId}`;

/** What a filter finds, whichever daemons are open or closed. */
export interface IFilterMatches {
  /** Daemons whose own name matches. */
  daemonIds: ReadonlySet<string>;
  /** Processes that match, and all the processes of those daemons. */
  processes: IProcessSummary[];
}

export function findFilterMatches({
  daemons,
  processes,
  matchingProcesses,
  highlight,
}: {
  daemons: IDaemonSummary[];
  processes: IProcessSummary[];
  /** Processes that match by their own fields. */
  matchingProcesses: IProcessSummary[];
  highlight: RegExp | null;
}): IFilterMatches {
  const daemonIds = new Set(
    daemons
      .filter(daemon => {
        if (!highlight) {
          return false;
        }
        // A global expression continues from its last match.
        highlight.lastIndex = 0;
        return highlight.test(daemon.label);
      })
      .map(daemon => daemon.daemonId)
  );
  const matching = new Set(matchingProcesses);
  return {
    daemonIds,
    processes: processes.filter(
      process => matching.has(process) || daemonIds.has(process.daemonId)
    ),
  };
}

/**
 * The rows of the process tree. Daemons keep the user's order, and a sort only
 * applies inside each of them, so the tree keeps its shape while the values move.
 * While filtering, a daemon with a match opens by itself, unless it was closed
 * during this filter, and one without any leaves the tree. The selected processes
 * stay listed: they are what the open page acts on.
 */
export function buildTreeRows({
  daemons,
  processes,
  filterMatches,
  isDaemonOpen,
  closedWhileFiltering,
  selection,
  sort,
}: {
  daemons: IDaemonSummary[];
  processes: IProcessSummary[];
  /** Null without a filter. */
  filterMatches: IFilterMatches | null;
  isDaemonOpen: (daemonId: string) => boolean;
  closedWhileFiltering: ReadonlySet<string>;
  selection: { daemonId: string; pmIds: number[] } | null;
  sort: IProcessSort | null;
}): ITreeRow[] {
  const matching = filterMatches && new Set(filterMatches.processes);
  const rows: ITreeRow[] = [];
  for (const daemon of daemons) {
    const all = processes.filter(process => process.daemonId === daemon.daemonId);
    const listed = matching
      ? all.filter(
          process =>
            matching.has(process) ||
            (selection?.daemonId === daemon.daemonId && selection.pmIds.includes(process.pmId))
        )
      : all;
    if (filterMatches && !filterMatches.daemonIds.has(daemon.daemonId) && !listed.length) {
      continue;
    }
    const isOpen = filterMatches
      ? !closedWhileFiltering.has(daemon.daemonId)
      : isDaemonOpen(daemon.daemonId);
    rows.push({
      kind: 'daemon',
      key: daemonRowKey(daemon.daemonId),
      daemon,
      processes: all,
      isOpen,
    });
    if (isOpen) {
      for (const process of sortProcesses(listed, sort)) {
        rows.push({
          kind: 'process',
          key: processRowKey(daemon.daemonId, process.pmId),
          daemon,
          process,
        });
      }
    }
  }
  return rows;
}

export interface IProcessTotals {
  online: number;
  offline: number;
  cpu: number;
  memory: number;
  restarts: number;
}

/** Totals for daemon rows and the summary bar. Only online processes contribute CPU and memory. */
export function sumProcesses(processes: IProcessSummary[]): IProcessTotals {
  const totals: IProcessTotals = { online: 0, offline: 0, cpu: 0, memory: 0, restarts: 0 };
  for (const process of processes) {
    if (process.status === 'online') {
      totals.online += 1;
      totals.cpu += process.cpu ?? 0;
      totals.memory += process.memory ?? 0;
    } else {
      totals.offline += 1;
    }
    totals.restarts += process.restarts;
  }
  return totals;
}
