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
import { daemonLink, namespaceLink } from '@/lib/process_route';
import {
  type IProcessSort,
  type IProcessSortKey,
  cycleProcessSort,
  formatProcessSort,
  parseProcessSort,
} from '@/lib/process_sort';
import {
  type ITreeRow,
  buildTreeRows,
  daemonRowKey,
  findFilterMatches,
  namespaceRowKey,
} from '@/lib/process_tree_rows';
import { trpc } from '@/lib/trpc';
import { compactPath } from '@/lib/utils';

import type { IDaemonConfig, IProcessListResult, IProcessSummary } from '@shared/contracts';
import type { IDesktopPreferenceKey } from '@shared/desktop_bridge';

const COLLAPSED_STORAGE_KEY = 'pm2-captain-collapsed-daemons' satisfies IDesktopPreferenceKey;
const COLLAPSED_NAMESPACES_STORAGE_KEY =
  'pm2-captain-collapsed-namespaces' satisfies IDesktopPreferenceKey;
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

/** Daemon IDs, or the row keys of namespaces, as a JSON list. */
function loadCollapsed(key: IDesktopPreferenceKey): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(readPreference(key) ?? '[]');
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
  toggleNamespace: (daemonId: string, namespace: string) => void;
  setAllDaemonsOpen: (isOpen: boolean) => void;
  isEveryDaemonOpen: boolean;
  /** The daemon selected in the tree: its row was clicked, or a process was opened from it. */
  focusedDaemonId: string | null;
  /** The namespace selected in the tree, inside the focused daemon. */
  focusedNamespace: string | null;
  /** Where closing the open process goes: back to where it was opened from. */
  closeLink: ReturnType<typeof daemonLink> | ReturnType<typeof namespaceLink> | { to: '/' };
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
  const routeNamespace = useParams({ strict: false, select: params => params.namespace });
  const routePmIds = useParams({
    strict: false,
    select: params => params.pmIds,
    structuralSharing: true,
  });
  const processFilter = useProcessListFilter();
  const [sort, setSortState] = useState(() => parseProcessSort(readPreference(SORT_STORAGE_KEY)));
  const [collapsedIds, setCollapsedIds] = useState(() => loadCollapsed(COLLAPSED_STORAGE_KEY));
  const [collapsedNamespaces, setCollapsedNamespaces] = useState(() =>
    loadCollapsed(COLLAPSED_NAMESPACES_STORAGE_KEY)
  );
  // What was closed while filtering belongs to that filter text, by row key. A
  // filter opens what it finds, and never changes what is remembered without one.
  const [closedInFilter, setClosedInFilter] = useState<{
    search: string;
    keys: ReadonlySet<string>;
  }>({ search: '', keys: NO_KEYS });
  const [remembered, setRemembered] = useState<{
    daemonId: string | null;
    namespace: string | null;
  }>(NO_FOCUS);

  const daemons = list.data?.daemons;
  const processes = list.data?.processes;

  // A daemon's or namespace's own address selects it. A process keeps it selected
  // only when it belongs to it, so that closing the process comes back to it.
  const focusedDaemonId =
    routeDaemonId && (!routePmIds || remembered.daemonId === routeDaemonId) ? routeDaemonId : null;
  const focusedNamespace = !focusedDaemonId
    ? null
    : !routePmIds
      ? (routeNamespace ?? null)
      : remembered.namespace &&
          (processes ?? NO_PROCESSES).every(
            item =>
              item.daemonId !== focusedDaemonId ||
              !routePmIds.includes(item.pmId) ||
              item.namespace === remembered.namespace
          )
        ? remembered.namespace
        : null;
  if (focusedDaemonId !== remembered.daemonId || focusedNamespace !== remembered.namespace) {
    setRemembered({ daemonId: focusedDaemonId, namespace: focusedNamespace });
  }

  const isDaemonOpen = useCallback(
    (daemonId: string) => !collapsedIds.has(daemonId),
    [collapsedIds]
  );
  const isNamespaceOpen = useCallback(
    (key: string) => !collapsedNamespaces.has(key),
    [collapsedNamespaces]
  );

  const setSort = useCallback((next: IProcessSort | null) => {
    setSortState(next);
    writePreference(SORT_STORAGE_KEY, formatProcessSort(next));
  }, []);

  const saveCollapsed = useCallback((next: ReadonlySet<string>) => {
    setCollapsedIds(next);
    writePreference(COLLAPSED_STORAGE_KEY, JSON.stringify([...next]));
  }, []);

  const saveCollapsedNamespaces = useCallback((next: ReadonlySet<string>) => {
    setCollapsedNamespaces(next);
    writePreference(COLLAPSED_NAMESPACES_STORAGE_KEY, JSON.stringify([...next]));
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

  // A process opened by its address, or from outside the tree, shows in its daemon
  // and its namespace.
  const selectionKey = routePmIds?.join(',');
  useEffect(() => {
    if (!routeDaemonId || !routePmIds) {
      return;
    }
    if (!isDaemonOpen(routeDaemonId)) {
      setDaemonOpen(routeDaemonId, true);
    }
    const groupKeys = (processes ?? NO_PROCESSES)
      .filter(item => item.daemonId === routeDaemonId && routePmIds.includes(item.pmId))
      .map(item => namespaceRowKey(routeDaemonId, item.namespace))
      .filter(key => collapsedNamespaces.has(key));
    if (groupKeys.length) {
      const next = new Set(collapsedNamespaces);
      groupKeys.forEach(key => next.delete(key));
      saveCollapsedNamespaces(next);
    }
    // Only a new selection opens them: the user can collapse them afterwards.
  }, [routeDaemonId, selectionKey, Boolean(processes)]);

  const filtered = useFilteredProcesses(processes ?? NO_PROCESSES);
  const { highlight, error: filterError } = filtered;
  // Plain text of only spaces filters nothing; an expression that does not compile filters everything out.
  const isFiltering = Boolean(highlight || filterError);
  // Another filter text starts over, also when an earlier one is typed again.
  const closedWhileFiltering =
    closedInFilter.search === processFilter.search ? closedInFilter.keys : NO_KEYS;
  if (closedInFilter.search !== processFilter.search) {
    setClosedInFilter({ search: processFilter.search, keys: NO_KEYS });
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
        isNamespaceOpen,
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
      isNamespaceOpen,
      closedWhileFiltering,
      routeDaemonId,
      routePmIds,
      sort,
    ]
  );

  const toggleClosedInFilter = useCallback(
    (key: string) => {
      const keys = new Set(closedWhileFiltering);
      if (!keys.delete(key)) {
        keys.add(key);
      }
      setClosedInFilter({ search: processFilter.search, keys });
    },
    [closedWhileFiltering, processFilter.search]
  );

  const toggleDaemon = useCallback(
    (daemonId: string) => {
      if (isFiltering) {
        toggleClosedInFilter(daemonRowKey(daemonId));
      } else {
        setDaemonOpen(daemonId, !isDaemonOpen(daemonId));
      }
    },
    [isDaemonOpen, isFiltering, setDaemonOpen, toggleClosedInFilter]
  );

  const toggleNamespace = useCallback(
    (daemonId: string, namespace: string) => {
      const key = namespaceRowKey(daemonId, namespace);
      if (isFiltering) {
        toggleClosedInFilter(key);
        return;
      }
      const next = new Set(collapsedNamespaces);
      if (!next.delete(key)) {
        next.add(key);
      }
      saveCollapsedNamespaces(next);
    },
    [collapsedNamespaces, isFiltering, saveCollapsedNamespaces, toggleClosedInFilter]
  );

  const isEveryDaemonOpen = rows.every(row => row.kind === 'process' || row.isOpen);
  /** Expanding opens the namespaces too. Collapsing closes only the daemons, so the groups inside keep how they were. */
  const setAllDaemonsOpen = useCallback(
    (isOpen: boolean) => {
      const daemonIds = isOpen ? [] : (daemons ?? []).map(item => item.daemonId);
      if (isFiltering) {
        setClosedInFilter({
          search: processFilter.search,
          keys: new Set(daemonIds.map(daemonRowKey)),
        });
        return;
      }
      saveCollapsed(new Set(daemonIds));
      if (isOpen) {
        saveCollapsedNamespaces(NO_KEYS);
      }
    },
    [daemons, isFiltering, processFilter.search, saveCollapsed, saveCollapsedNamespaces]
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
      toggleNamespace,
      setAllDaemonsOpen,
      isEveryDaemonOpen,
      focusedDaemonId,
      focusedNamespace,
      closeLink:
        focusedDaemonId && focusedNamespace
          ? namespaceLink(focusedDaemonId, focusedNamespace)
          : focusedDaemonId
            ? daemonLink(focusedDaemonId)
            : { to: '/' },
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
      toggleNamespace,
      setAllDaemonsOpen,
      isEveryDaemonOpen,
      focusedDaemonId,
      focusedNamespace,
      locationOf,
    ]
  );

  return <ProcessTreeContext.Provider value={value}>{children}</ProcessTreeContext.Provider>;
}

const NO_PROCESSES: IProcessListResult['processes'] = [];
const NO_KEYS: ReadonlySet<string> = new Set();
const NO_FOCUS = { daemonId: null, namespace: null };
