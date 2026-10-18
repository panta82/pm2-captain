import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Toaster } from 'sonner';

import { DaemonSelectionProvider } from '@/lib/daemon_selection';
import { LogSearchProvider } from '@/lib/log_search';
import { readPreference, writePreference } from '@/lib/preferences';
import { ProcessListFilterProvider } from '@/lib/process_list_filter';
import { isProcessTab, processLink } from '@/lib/process_route';
import { formatPmIds, parsePmIds } from '@/lib/process_selection';
import { trpc } from '@/lib/trpc';

import { AppHeader } from '@/components/app_header';
import { DaemonManagerProvider } from '@/components/daemon_manager';
import { ProcessFilterField } from '@/components/process_filter_field';
import { RegistryWarning } from '@/components/registry_warning';
import { RestartOverlay } from '@/components/restart_overlay';
import { UpdateNotice } from '@/components/update_notice';

import type { IDesktopPreferenceKey } from '@shared/desktop_bridge';

import { ErrorPage } from '@/pages/error_page';
import { NotFoundPage } from '@/pages/not_found_page';
import { ProcessLayout } from '@/pages/process_layout';
import { StatusPage } from '@/pages/status_page';

const SELECTED_DAEMON_STORAGE_KEY = 'pm2-captain-selected-daemon' satisfies IDesktopPreferenceKey;

function loadSelectedDaemonId(): string | null {
  return readPreference(SELECTED_DAEMON_STORAGE_KEY);
}

function RootLayout() {
  const list = trpc.processes.list.useQuery(undefined, { refetchInterval: 2_000 });
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const routeDaemonId = useParams({ strict: false, select: params => params.daemonId });
  const routePmIds = useParams({
    strict: false,
    select: params => params.pmIds,
    structuralSharing: true,
  });
  const routeTab = useParams({ strict: false, select: params => params.tab });
  const processDetailOpen = routeTab !== undefined;
  // The logs page already holds a stream that reports this tab's presence.
  const isLogsPageOpen = routeTab === 'logs';
  trpc.session.presence.useSubscription(undefined, { enabled: !isLogsPageOpen });
  const [search, setSearch] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [storedDaemonId, setStoredDaemonId] = useState(loadSelectedDaemonId);
  const processListFilter = useMemo(
    () => ({ search, caseSensitive, regex, setSearch, setCaseSensitive, setRegex }),
    [search, caseSensitive, regex]
  );

  const storeDaemonId = useCallback((daemonId: string) => {
    setStoredDaemonId(daemonId);
    writePreference(SELECTED_DAEMON_STORAGE_KEY, daemonId);
  }, []);

  // A process URL pins its daemon; otherwise the remembered choice applies.
  // Without either, prefer a daemon that can show processes, so a computer
  // without PM2 opens on a remote daemon instead of the unavailable local one.
  const daemons = list.data?.daemons;
  const selectedDaemon =
    daemons?.find(daemon => daemon.daemonId === routeDaemonId) ??
    daemons?.find(daemon => daemon.daemonId === storedDaemonId) ??
    daemons?.find(daemon => daemon.status === 'online') ??
    daemons?.find(daemon => daemon.status === 'connecting' || daemon.status === 'reconnecting') ??
    daemons?.[0];
  const selectedDaemonId = selectedDaemon?.daemonId ?? null;

  useEffect(() => {
    if (routeDaemonId) {
      storeDaemonId(routeDaemonId);
    }
  }, [routeDaemonId, storeDaemonId]);

  // Keep an automatic pick once it is online, so a later outage of that daemon
  // does not silently move the user to another one.
  const isAutomaticPickOnline =
    !routeDaemonId && selectedDaemonId !== storedDaemonId && selectedDaemon?.status === 'online';
  useEffect(() => {
    if (isAutomaticPickOnline && selectedDaemonId) {
      storeDaemonId(selectedDaemonId);
    }
  }, [isAutomaticPickOnline, selectedDaemonId, storeDaemonId]);

  const selectDaemon = useCallback(
    (daemonId: string) => {
      storeDaemonId(daemonId);
      if (!routeDaemonId || routeDaemonId === daemonId) {
        return;
      }
      // A process page shows one daemon. Follow the switch to the same-named
      // process on the new daemon, or its first one, rather than mixing daemons.
      const processes = utils.processes.list.getData()?.processes || [];
      const currentName = processes.find(
        process => process.daemonId === routeDaemonId && process.pmId === routePmIds?.[0]
      )?.name;
      const daemonProcesses = processes.filter(process => process.daemonId === daemonId);
      const target =
        daemonProcesses.find(process => process.name === currentName) ?? daemonProcesses[0];
      if (target) {
        void navigate(processLink(daemonId, [target.pmId]));
      } else {
        void navigate({ to: '/' });
      }
    },
    [navigate, routeDaemonId, routePmIds, storeDaemonId, utils]
  );

  const daemonSelection = useMemo(
    () => ({ selectedDaemonId, selectDaemon }),
    [selectedDaemonId, selectDaemon]
  );

  const selectedDaemonTitle = selectedDaemon
    ? selectedDaemon.hostname || selectedDaemon.label
    : null;
  useEffect(() => {
    document.title = selectedDaemonTitle ? `${selectedDaemonTitle} — PM2 Captain` : 'PM2 Captain';
  }, [selectedDaemonTitle]);

  return (
    <DaemonSelectionProvider value={daemonSelection}>
      <ProcessListFilterProvider value={processListFilter}>
        <LogSearchProvider>
          <DaemonManagerProvider>
            <div
              data-component="RootLayout"
              className="flex h-svh min-h-0 flex-col overflow-hidden bg-surface-plane text-white"
            >
              <UpdateNotice />
              {list.data?.registryWarning ? (
                <RegistryWarning message={list.data.registryWarning} />
              ) : null}
              {!processDetailOpen ? (
                <AppHeader
                  data={list.data}
                  loading={list.isPending && !list.data}
                  failed={list.isError}
                  filter={<ProcessFilterField />}
                />
              ) : null}
              <Outlet />
              <RestartOverlay />
              <Toaster
                theme="dark"
                position="bottom-left"
                toastOptions={{
                  style: {
                    background: 'var(--color-panel)',
                    border: '1px solid var(--color-line)',
                    color: '#fff',
                  },
                }}
              />
            </div>
          </DaemonManagerProvider>
        </LogSearchProvider>
      </ProcessListFilterProvider>
    </DaemonSelectionProvider>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
  errorComponent: ErrorPage,
});
const statusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: StatusPage,
});
const processRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'daemons/$daemonId/processes/$pmIds',
  params: {
    // A malformed selection matches no route, so it shows the not-found page.
    parse: ({ daemonId, pmIds }) => {
      const parsedPmIds = parsePmIds(pmIds);
      return parsedPmIds.length ? { daemonId, pmIds: parsedPmIds } : false;
    },
    stringify: ({ daemonId, pmIds }) => ({ daemonId, pmIds: formatPmIds(pmIds) }),
  },
});
const processIndexRoute = createRoute({
  getParentRoute: () => processRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ ...processLink(params.daemonId, params.pmIds), replace: true });
  },
});
// ProcessLayout owns the retained tab trees, so switching tabs only changes a parameter.
const processTabRoute = createRoute({
  getParentRoute: () => processRoute,
  path: '$tab',
  params: {
    parse: ({ tab }) => (isProcessTab(tab) ? { tab } : false),
  },
  beforeLoad: ({ params, location }) => {
    // One selection has one address, so a tab link can tell that it is active,
    // and several processes have no Logs tab. Only the two plain trailing
    // segments are compared, so encoding elsewhere cannot cause a redirect loop.
    const link = processLink(params.daemonId, params.pmIds, params.tab);
    const [pmIdsSegment, tabSegment] = location.pathname.split('/').slice(-2);
    if (pmIdsSegment !== formatPmIds(params.pmIds) || tabSegment !== link.params.tab) {
      throw redirect({ ...link, replace: true });
    }
  },
  component: ProcessLayout,
});

const routeTree = rootRoute.addChildren([
  statusRoute,
  processRoute.addChildren([processIndexRoute, processTabRoute]),
]);
const router = createRouter({
  routeTree,
  defaultNotFoundComponent: NotFoundPage,
  defaultErrorComponent: ErrorPage,
  // A selection of processes is a comma-separated `$pmIds`; keep it readable in the URL.
  pathParamsAllowedCharacters: [','],
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function Root() {
  return <RouterProvider router={router} />;
}
