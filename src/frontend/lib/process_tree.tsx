import { useParams } from '@tanstack/react-router';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { readPreference, writePreference } from '@/lib/preferences';
import { useFilteredProcesses, useProcessListFilter } from '@/lib/process_list_filter';
import { daemonLink } from '@/lib/process_route';
import {
  type IProcessSort,
  type IProcessSortKey,
  cycleProcessSort,
  formatProcessSort,
  parseProcessSort,
} from '@/lib/process_sort';
import { type ITreeRow, buildTreeRows, findFilterMatches } from '@/lib/process_tree_rows';
import { trpc } from '@/lib/trpc';
import { compactPath } from '@/lib/utils';

import type { IDaemonConfig, IProcessListResult, IProcessSummary } from '@shared/contracts';
import type { IDesktopPreferenceKey } from '@shared/desktop_bridge';

const COLLAPSED_STORAGE_KEY = 'pm2-captain-collapsed-daemons' satisfies IDesktopPreferenceKey;
const SORT_STORAGE_KEY = 'pm2-captain-process-sort' satisfies IDesktopPreferenceKey;

/** Only the destination of an SSH daemon: its other arguments can carry sensitive values. */
function describeLocation(config: IDaemonConfig): string {
  const home = config.pm2Home ? compactPath(config.pm2Home) : null;
  if (config.kind === 'local') {
    return home ?? '';
  }
  const destination = config.sshArgs.at(-1) ?? '';
  return home ? `${destination}:${home}` : destination;
}

function loadCollapsedDaemons(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(readPreference(COLLAPSED_STORAGE_KEY) ?? '[]');
    return new Set(
      Array.isArray(stored) ? stored.filter(item => typeof item === 'string') : undefined
    );
  } catch {
    return new Set();
  }
}

/**
 * The tree's view of the whole process list. It lives above the routes, so the
 * tree keeps its state while the page next to it changes.
 */
export interface IProcessTree {
  data: IProcessListResult | undefined;
  rows: ITreeRow[];
  /** All processes the filter lists, also those inside closed daemons. */
  listedProcesses: IProcessSummary[];
  highlight: RegExp | null;
  filterError: string;
  sort: IProcessSort | null;
  setSort: (next: IProcessSort | null) => void;
  /** A column header was clicked. */
  cycleSort: (key: IProcessSortKey) => void;
  toggleDaemon: (daemonId: string) => void;
  setAllDaemonsOpen: (isOpen: boolean) => void;
  isEveryDaemonOpen: boolean;
  /** The daemon selected in the tree: its row was clicked, or a process was opened from it. */
  focusedDaemonId: string | null;
  /** Where closing the open process goes: back to where it was opened from. */
  closeLink: ReturnType<typeof daemonLink> | { to: '/' };
  locationOf: (daemonId: string) => string;
}

const ProcessTreeContext = createContext<IProcessTree | null>(null);

export function useProcessTree(): IProcessTree {
  const tree = useContext(ProcessTreeContext);
  if (!tree) {
    throw new Error('useProcessTree is used outside ProcessTreeProvider.');
  }
  return tree;
}

export function ProcessTreeProvider({ children }: { children: ReactNode }) {
  const list = trpc.processes.list.useQuery(undefined, { refetchInterval: 2_000 });
  // Only for where a daemon is: a few seconds late is fine for that, and the
  // connection itself comes from the process list.
  const settings = trpc.daemons.list.useQuery(undefined, { refetchInterval: 5_000 });
  const routeDaemonId = useParams({ strict: false, select: params => params.daemonId });
  const routePmIds = useParams({
    strict: false,
    select: params => params.pmIds,
    structuralSharing: true,
  });
  const processFilter = useProcessListFilter();
  const [sort, setSortState] = useState(() => parseProcessSort(readPreference(SORT_STORAGE_KEY)));
  const [collapsedIds, setCollapsedIds] = useState(loadCollapsedDaemons);
  // What was closed while filtering belongs to that filter text. A filter opens
  // what it finds, and never changes what is remembered without one.
  const [closedInFilter, setClosedInFilter] = useState<{
    search: string;
    daemonIds: ReadonlySet<string>;
  }>({ search: '', daemonIds: NO_DAEMON_IDS });
  const [rememberedDaemonId, setRememberedDaemonId] = useState<string | null>(null);

  // A daemon's own address selects it. A process keeps it selected only when it
  // belongs to that daemon, so that closing the process comes back to it.
  const focusedDaemonId =
    routeDaemonId && (!routePmIds || rememberedDaemonId === routeDaemonId) ? routeDaemonId : null;
  if (focusedDaemonId !== rememberedDaemonId) {
    setRememberedDaemonId(focusedDaemonId);
  }

  const isDaemonOpen = useCallback(
    (daemonId: string) => !collapsedIds.has(daemonId),
    [collapsedIds]
  );

  const setSort = useCallback((next: IProcessSort | null) => {
    setSortState(next);
    writePreference(SORT_STORAGE_KEY, formatProcessSort(next));
  }, []);

  const saveCollapsed = useCallback((next: ReadonlySet<string>) => {
    setCollapsedIds(next);
    writePreference(COLLAPSED_STORAGE_KEY, JSON.stringify([...next]));
  }, []);

  const setDaemonOpen = useCallback(
    (daemonId: string, isOpen: boolean) => {
      const next = new Set(collapsedIds);
      if (isOpen) {
        next.delete(daemonId);
      } else {
        next.add(daemonId);
      }
      saveCollapsed(next);
    },
    [collapsedIds, saveCollapsed]
  );

  // A process opened by its address, or from outside the tree, shows in its daemon.
  const selectionKey = routePmIds?.join(',');
  useEffect(() => {
    if (routeDaemonId && selectionKey && !isDaemonOpen(routeDaemonId)) {
      setDaemonOpen(routeDaemonId, true);
    }
    // Only a new selection opens it: the user can collapse the daemon afterwards.
  }, [routeDaemonId, selectionKey]);

  const daemons = list.data?.daemons;
  const processes = list.data?.processes;
  const filtered = useFilteredProcesses(processes ?? NO_PROCESSES);
  const { highlight, error: filterError } = filtered;
  const isFiltering = Boolean(processFilter.search);
  // Another filter text starts over, also when an earlier one is typed again.
  const closedWhileFiltering =
    closedInFilter.search === processFilter.search ? closedInFilter.daemonIds : NO_DAEMON_IDS;
  if (closedInFilter.search !== processFilter.search) {
    setClosedInFilter({ search: processFilter.search, daemonIds: NO_DAEMON_IDS });
  }
  const filterMatches = useMemo(
    () =>
      isFiltering
        ? findFilterMatches({
            daemons: daemons ?? [],
            processes: processes ?? NO_PROCESSES,
            matchingProcesses: filtered.processes,
            highlight,
          })
        : null,
    [daemons, processes, filtered.processes, isFiltering, highlight]
  );
  const listedProcesses = filterMatches?.processes ?? processes ?? NO_PROCESSES;
  const rows = useMemo(
    () =>
      buildTreeRows({
        daemons: daemons ?? [],
        processes: processes ?? NO_PROCESSES,
        filterMatches,
        isDaemonOpen,
        closedWhileFiltering,
        selection:
          routeDaemonId && routePmIds ? { daemonId: routeDaemonId, pmIds: routePmIds } : null,
        sort,
      }),
    [
      daemons,
      processes,
      filterMatches,
      isDaemonOpen,
      closedWhileFiltering,
      routeDaemonId,
      routePmIds,
      sort,
    ]
  );

  const toggleDaemon = useCallback(
    (daemonId: string) => {
      if (!isFiltering) {
        setDaemonOpen(daemonId, !isDaemonOpen(daemonId));
        return;
      }
      const daemonIds = new Set(closedWhileFiltering);
      if (!daemonIds.delete(daemonId)) {
        daemonIds.add(daemonId);
      }
      setClosedInFilter({ search: processFilter.search, daemonIds });
    },
    [closedWhileFiltering, isDaemonOpen, isFiltering, processFilter.search, setDaemonOpen]
  );

  const isEveryDaemonOpen = rows.every(row => row.kind !== 'daemon' || row.isOpen);
  const setAllDaemonsOpen = useCallback(
    (isOpen: boolean) => {
      const daemonIds = new Set(isOpen ? [] : (daemons ?? []).map(item => item.daemonId));
      if (isFiltering) {
        setClosedInFilter({ search: processFilter.search, daemonIds });
      } else {
        saveCollapsed(daemonIds);
      }
    },
    [daemons, isFiltering, processFilter.search, saveCollapsed]
  );

  const settingsData = settings.data;
  const locationOf = useCallback(
    (daemonId: string) => {
      const config = settingsData?.find(daemon => daemon.daemonId === daemonId)?.config;
      return config ? describeLocation(config) : '';
    },
    [settingsData]
  );

  const value = useMemo(
    (): IProcessTree => ({
      data: list.data,
      rows,
      listedProcesses,
      highlight,
      filterError,
      sort,
      setSort,
      cycleSort: key => setSort(cycleProcessSort(sort, key)),
      toggleDaemon,
      setAllDaemonsOpen,
      isEveryDaemonOpen,
      focusedDaemonId,
      closeLink: focusedDaemonId ? daemonLink(focusedDaemonId) : { to: '/' },
      locationOf,
    }),
    [
      list.data,
      rows,
      listedProcesses,
      highlight,
      filterError,
      sort,
      setSort,
      toggleDaemon,
      setAllDaemonsOpen,
      isEveryDaemonOpen,
      focusedDaemonId,
      locationOf,
    ]
  );

  return <ProcessTreeContext.Provider value={value}>{children}</ProcessTreeContext.Provider>;
}

const NO_PROCESSES: IProcessListResult['processes'] = [];
const NO_DAEMON_IDS: ReadonlySet<string> = new Set();
