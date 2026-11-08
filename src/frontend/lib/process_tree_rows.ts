import { type IProcessSort, compareProcesses, sortProcesses } from '@/lib/process_sort';

import type { IDaemonSummary, IProcessSummary } from '@shared/contracts';

/** A daemon row with all its processes, including those hidden by the filter. */
export interface IDaemonTreeRow {
  kind: 'daemon';
  key: string;
  daemon: IDaemonSummary;
  processes: IProcessSummary[];
  /**
   * The processes the filter lists under it, in the tree's order, also while closed.
   * Pinned ones are listed at the top instead. Its check box selects these.
   */
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
  /** Like a daemon's: what the filter lists under it, without the pinned ones. */
  listed: IProcessSummary[];
  isOpen: boolean;
}

/**
 * Where a process is listed: pinned at the top of the tree, above the daemons,
 * directly under its daemon, or inside its namespace's row.
 */
export type IProcessPlacement = 'pinned' | 'daemon' | 'namespace';

export interface IProcessTreeRow {
  kind: 'process';
  key: string;
  daemon: IDaemonSummary;
  process: IProcessSummary;
  placement: IProcessPlacement;
}

export type ITreeRow = IDaemonTreeRow | INamespaceTreeRow | IProcessTreeRow;

/** A process without a namespace of its own. PM2 gives it this one. */
export const DEFAULT_NAMESPACE = 'default';

export const daemonRowKey = (daemonId: string) => `daemon:${daemonId}`;
export const namespaceRowKey = (daemonId: string, namespace: string) =>
  `namespace:${daemonId}:${namespace}`;
export const processRowKey = (daemonId: string, pmId: number) => `process:${daemonId}:${pmId}`;

/** The row a process is listed under: its namespace's or its daemon's. A pinned one has none. */
export function parentRowKey(row: IProcessTreeRow): string | null {
  switch (row.placement) {
    case 'pinned':
      return null;
    case 'daemon':
      return daemonRowKey(row.daemon.daemonId);
    case 'namespace':
      return namespaceRowKey(row.daemon.daemonId, row.process.namespace);
  }
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

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
 * The rows of the process tree. Pinned processes come first, from every daemon,
 * then the daemons in the user's order. Inside a daemon, each named namespace is
 * a group, in alphabetical order, and the processes in PM2's default namespace
 * follow the groups directly. A sort only applies inside the pinned processes and
 * inside each group, so the tree keeps its shape while the values move. While
 * filtering, a daemon or group with a match opens by itself, unless it was closed
 * during this filter, and one without any leaves the tree. The selected processes
 * stay listed: they are what the open page acts on.
 */
export function buildTreeRows({
  daemons,
  processes,
  filterMatches,
  isDaemonOpen,
  isNamespaceOpen,
  isPinned,
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
  isPinned: (process: IProcessSummary) => boolean;
  /** Row keys of the daemons and namespaces closed during this filter. */
  closedWhileFiltering: ReadonlySet<string>;
  selection: { daemonId: string; pmIds: number[] } | null;
  sort: IProcessSort | null;
}): ITreeRow[] {
  const matching = filterMatches && new Set(filterMatches.processes);
  const isListed = (process: IProcessSummary) =>
    !matching ||
    matching.has(process) ||
    (selection?.daemonId === process.daemonId && selection.pmIds.includes(process.pmId));
  const processRow = (
    daemon: IDaemonSummary,
    process: IProcessSummary,
    placement: IProcessPlacement
  ): IProcessTreeRow => ({
    kind: 'process',
    key: processRowKey(daemon.daemonId, process.pmId),
    daemon,
    process,
    placement,
  });

  const pinnedRows: IProcessTreeRow[] = [];
  const daemonRows: ITreeRow[] = [];
  const processesByDaemon = groupBy(processes, process => process.daemonId);
  for (const daemon of daemons) {
    const all = processesByDaemon.get(daemon.daemonId) ?? [];
    const listed: IProcessSummary[] = [];
    for (const process of all) {
      if (!isListed(process)) {
        continue;
      }
      if (isPinned(process)) {
        pinnedRows.push(processRow(daemon, process, 'pinned'));
      } else {
        listed.push(process);
      }
    }
    if (filterMatches && !filterMatches.daemonIds.has(daemon.daemonId) && !listed.length) {
      continue;
    }

    // Only namespaces with a process listed here: one whose processes are all
    // pinned or filtered out has nothing to open.
    const allByNamespace = groupBy(all, process => process.namespace);
    const listedByNamespace = groupBy(listed, process => process.namespace);
    const groups = [...listedByNamespace]
      .filter(([namespace]) => namespace !== DEFAULT_NAMESPACE)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([namespace, inGroup]) => ({
        namespace,
        key: namespaceRowKey(daemon.daemonId, namespace),
        processes: allByNamespace.get(namespace) ?? inGroup,
        listed: sortProcesses(inGroup, sort),
      }));
    const loose = sortProcesses(listedByNamespace.get(DEFAULT_NAMESPACE) ?? [], sort);

    const key = daemonRowKey(daemon.daemonId);
    const isOpen = filterMatches ? !closedWhileFiltering.has(key) : isDaemonOpen(daemon.daemonId);
    daemonRows.push({
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
      daemonRows.push({ kind: 'namespace', daemon, ...group, isOpen: isGroupOpen });
      if (isGroupOpen) {
        daemonRows.push(...group.listed.map(process => processRow(daemon, process, 'namespace')));
      }
    }
    daemonRows.push(...loose.map(process => processRow(daemon, process, 'daemon')));
  }

  // One list, sorted across the daemons. Without a sort, they keep the daemons' order.
  if (sort) {
    pinnedRows.sort((left, right) => compareProcesses(sort, left.process, right.process));
  }
  return [...pinnedRows, ...daemonRows];
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
