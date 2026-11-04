import { type IProcessSort, sortProcesses } from '@/lib/process_sort';

import type { IDaemonSummary, IProcessSummary } from '@shared/contracts';

/** A daemon row with all its processes, including those hidden by the filter. */
export interface IDaemonTreeRow {
  kind: 'daemon';
  key: string;
  daemon: IDaemonSummary;
  processes: IProcessSummary[];
  /** The processes the filter lists, in the tree's order, also while closed. Its check box selects these. */
  listed: IProcessSummary[];
  isOpen: boolean;
}

/** A named PM2 namespace inside a daemon, with all its processes. */
export interface INamespaceTreeRow {
  kind: 'namespace';
  key: string;
  daemon: IDaemonSummary;
  namespace: string;
  processes: IProcessSummary[];
  /** The processes the filter lists, in the tree's order, also while closed. Its check box selects these. */
  listed: IProcessSummary[];
  isOpen: boolean;
}

export interface IProcessTreeRow {
  kind: 'process';
  key: string;
  daemon: IDaemonSummary;
  process: IProcessSummary;
  /** Listed inside its namespace's row rather than directly under the daemon. */
  isGrouped: boolean;
}

export type ITreeRow = IDaemonTreeRow | INamespaceTreeRow | IProcessTreeRow;

/** A process without a namespace of its own. PM2 gives it this one. */
export const DEFAULT_NAMESPACE = 'default';

export const daemonRowKey = (daemonId: string) => `daemon:${daemonId}`;
export const namespaceRowKey = (daemonId: string, namespace: string) =>
  `namespace:${daemonId}:${namespace}`;
export const processRowKey = (daemonId: string, pmId: number) => `process:${daemonId}:${pmId}`;

/** The row a process is listed under: its namespace's, or its daemon's. */
export const parentRowKey = (row: IProcessTreeRow) =>
  row.isGrouped
    ? namespaceRowKey(row.daemon.daemonId, row.process.namespace)
    : daemonRowKey(row.daemon.daemonId);

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
 * The rows of the process tree. Daemons keep the user's order. Inside a daemon,
 * each named namespace is a group, in alphabetical order, and the processes in
 * PM2's default namespace follow the groups directly. A sort only applies inside
 * each group, so the tree keeps its shape while the values move. While filtering,
 * a daemon or group with a match opens by itself, unless it was closed during this
 * filter, and one without any leaves the tree. The selected processes stay listed:
 * they are what the open page acts on.
 */
export function buildTreeRows({
  daemons,
  processes,
  filterMatches,
  isDaemonOpen,
  isNamespaceOpen,
  closedWhileFiltering,
  selection,
  sort,
}: {
  daemons: IDaemonSummary[];
  processes: IProcessSummary[];
  /** Null without a filter. */
  filterMatches: IFilterMatches | null;
  isDaemonOpen: (daemonId: string) => boolean;
  /** Takes the namespace's row key. */
  isNamespaceOpen: (key: string) => boolean;
  /** Row keys of the daemons and namespaces closed during this filter. */
  closedWhileFiltering: ReadonlySet<string>;
  selection: { daemonId: string; pmIds: number[] } | null;
  sort: IProcessSort | null;
}): ITreeRow[] {
  const matching = filterMatches && new Set(filterMatches.processes);
  const rows: ITreeRow[] = [];
  const pushProcesses = (daemon: IDaemonSummary, sorted: IProcessSummary[], isGrouped: boolean) => {
    for (const process of sorted) {
      rows.push({
        kind: 'process',
        key: processRowKey(daemon.daemonId, process.pmId),
        daemon,
        process,
        isGrouped,
      });
    }
  };
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
    const namespaces = [
      ...new Set(
        all.map(process => process.namespace).filter(namespace => namespace !== DEFAULT_NAMESPACE)
      ),
    ].sort((a, b) => a.localeCompare(b));
    const groups = namespaces
      .map(namespace => ({
        namespace,
        key: namespaceRowKey(daemon.daemonId, namespace),
        processes: all.filter(process => process.namespace === namespace),
        listed: sortProcesses(
          listed.filter(process => process.namespace === namespace),
          sort
        ),
      }))
      .filter(group => !filterMatches || group.listed.length);
    const loose = sortProcesses(
      listed.filter(process => process.namespace === DEFAULT_NAMESPACE),
      sort
    );

    const key = daemonRowKey(daemon.daemonId);
    const isOpen = filterMatches ? !closedWhileFiltering.has(key) : isDaemonOpen(daemon.daemonId);
    rows.push({
      kind: 'daemon',
      key,
      daemon,
      processes: all,
      listed: [...groups.flatMap(group => group.listed), ...loose],
      isOpen,
    });
    if (!isOpen) {
      continue;
    }
    for (const group of groups) {
      const isGroupOpen = filterMatches
        ? !closedWhileFiltering.has(group.key)
        : isNamespaceOpen(group.key);
      rows.push({ kind: 'namespace', daemon, ...group, isOpen: isGroupOpen });
      if (isGroupOpen) {
        pushProcesses(daemon, group.listed, true);
      }
    }
    pushProcesses(daemon, loose, false);
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
