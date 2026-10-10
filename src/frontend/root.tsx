import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useParams,
  useRouterState,
} from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Toaster } from 'sonner';

import { DaemonSelectionProvider } from '@/lib/daemon_selection';
import { ProcessListFilterProvider } from '@/lib/process_list_filter';
import { processDetailTo } from '@/lib/process_tab';
import { trpc } from '@/lib/trpc';

import { AppHeader } from '@/components/app_header';
import { DaemonManagerProvider } from '@/components/daemon_manager';
import { ProcessFilterField } from '@/components/process_filter_field';
import { RestartOverlay } from '@/components/restart_overlay';

import { EnvPage } from '@/pages/env_page';
import { ErrorPage } from '@/pages/error_page';
import { InfoPage } from '@/pages/info_page';
import { LogsPage } from '@/pages/logs_page';
import { NotFoundPage } from '@/pages/not_found_page';
import { ProcessLayout } from '@/pages/process_layout';
import { StatusPage } from '@/pages/status_page';

const SELECTED_DAEMON_STORAGE_KEY = 'pm2-captain-selected-daemon';

function loadSelectedDaemonId(): string | null {
  try {
    return localStorage.getItem(SELECTED_DAEMON_STORAGE_KEY);
  } catch {
    return null;
  }
}

function RootLayout() {
  const list = trpc.processes.list.useQuery(undefined, { refetchInterval: 2_000 });
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const { daemonId: routeDaemonId, pmId: routePmId } = useParams({ strict: false });
  const processDetailOpen = useRouterState({
    select: state => state.location.pathname.startsWith('/daemons/'),
  });
  // The logs page already holds a stream that reports this tab's presence.
  const isLogsPageOpen = useRouterState({
    select: state => state.location.pathname.endsWith('/logs'),
  });
  trpc.session.presence.useSubscription(undefined, { enabled: !isLogsPageOpen });
  const [search, setSearch] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [storedDaemonId, setStoredDaemonId] = useState(loadSelectedDaemonId);

  const storeDaemonId = useCallback((daemonId: string) => {
    setStoredDaemonId(daemonId);
    try {
      localStorage.setItem(SELECTED_DAEMON_STORAGE_KEY, daemonId);
    } catch {
      // Ignore private-mode and quota failures.
    }
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
        process => process.daemonId === routeDaemonId && String(process.pmId) === routePmId
      )?.name;
      const daemonProcesses = processes.filter(process => process.daemonId === daemonId);
      const target =
        daemonProcesses.find(process => process.name === currentName) ?? daemonProcesses[0];
      if (target) {
        void navigate({ to: processDetailTo(), params: { daemonId, pmId: String(target.pmId) } });
      } else {
        void navigate({ to: '/' });
      }
    },
    [navigate, routeDaemonId, routePmId, storeDaemonId, utils]
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
      <ProcessListFilterProvider
        value={{
          search,
          caseSensitive,
          regex,
          setSearch,
          setCaseSensitive,
          setRegex,
        }}
      >
        <DaemonManagerProvider>
          <div
            data-component="RootLayout"
            className="flex h-svh min-h-0 flex-col overflow-hidden bg-surface-plane text-white"
          >
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
  path: 'daemons/$daemonId/processes/$pmId',
  component: ProcessLayout,
});
const infoRoute = createRoute({
  getParentRoute: () => processRoute,
  path: 'info',
  component: InfoPage,
});
const envRoute = createRoute({
  getParentRoute: () => processRoute,
  path: 'env',
  component: EnvPage,
});
const logsRoute = createRoute({
  getParentRoute: () => processRoute,
  path: 'logs',
  component: LogsPage,
});

const routeTree = rootRoute.addChildren([
  statusRoute,
  processRoute.addChildren([infoRoute, envRoute, logsRoute]),
]);
const router = createRouter({
  routeTree,
  defaultNotFoundComponent: NotFoundPage,
  defaultErrorComponent: ErrorPage,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function Root() {
  return <RouterProvider router={router} />;
}
