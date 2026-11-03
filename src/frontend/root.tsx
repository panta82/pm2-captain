import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useParams,
} from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { Toaster } from 'sonner';

import { PROCESS_LIST_ATTRIBUTE, focusProcessList, isTypingTarget } from '@/lib/keyboard_shortcuts';
import { LogSearchProvider } from '@/lib/log_search';
import { modalRoot } from '@/lib/page_find';
import { ProcessListFilterProvider } from '@/lib/process_list_filter';
import { isProcessTab, processLink } from '@/lib/process_route';
import { formatPmIds, parsePmIds } from '@/lib/process_selection';
import { ProcessTreeProvider } from '@/lib/process_tree';
import { trpc } from '@/lib/trpc';

import { DaemonManagerProvider } from '@/components/daemon_manager';
import { KeyboardShortcutsProvider } from '@/components/keyboard_shortcuts';
import { RegistryWarning } from '@/components/registry_warning';
import { RestartOverlay } from '@/components/restart_overlay';
import { UpdateNotice } from '@/components/update_notice';
import { Workspace } from '@/components/workspace';

import { ErrorPage } from '@/pages/error_page';
import { NotFoundPage } from '@/pages/not_found_page';
import { ProcessLayout } from '@/pages/process_layout';
import { StatusPage } from '@/pages/status_page';

function RootLayout() {
  const list = trpc.processes.list.useQuery(undefined, { refetchInterval: 2_000 });
  const routeDaemonId = useParams({ strict: false, select: params => params.daemonId });
  const routeTab = useParams({ strict: false, select: params => params.tab });
  // The logs page already holds a stream that reports this tab's presence.
  const isLogsPageOpen = routeTab === 'logs';
  trpc.session.presence.useSubscription(undefined, { enabled: !isLogsPageOpen });
  const [search, setSearch] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const processListFilter = useMemo(
    () => ({ search, caseSensitive, regex, setSearch, setCaseSensitive, setRegex }),
    [search, caseSensitive, regex]
  );

  // Escape that nothing else used: from a control outside the process list,
  // such as the sort button, or from nowhere, back to the list; there, it
  // clears the process filter. A menu or box that handled the key keeps it.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const hasModifier = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
      if (
        event.key !== 'Escape' ||
        hasModifier ||
        event.defaultPrevented ||
        isTypingTarget(event.target) ||
        modalRoot()
      ) {
        return;
      }
      const isInList = document.activeElement?.closest(`[${PROCESS_LIST_ATTRIBUTE}]`);
      if (!isInList && focusProcessList()) {
        event.preventDefault();
      } else if (search) {
        event.preventDefault();
        setSearch('');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [search]);

  const openDaemon = list.data?.daemons.find(daemon => daemon.daemonId === routeDaemonId);
  const openDaemonTitle = openDaemon ? openDaemon.hostname || openDaemon.label : null;
  useEffect(() => {
    document.title = openDaemonTitle ? `${openDaemonTitle} — PM2 Captain` : 'PM2 Captain';
  }, [openDaemonTitle]);

  return (
    <ProcessListFilterProvider value={processListFilter}>
      <ProcessTreeProvider>
        <LogSearchProvider>
          <DaemonManagerProvider>
            <KeyboardShortcutsProvider>
              <div
                data-component="RootLayout"
                className="flex h-svh min-h-0 flex-col overflow-hidden bg-surface-plane text-white"
              >
                <UpdateNotice />
                {list.data?.registryWarning ? (
                  <RegistryWarning message={list.data.registryWarning} />
                ) : null}
                <Workspace>
                  <Outlet />
                </Workspace>
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
            </KeyboardShortcutsProvider>
          </DaemonManagerProvider>
        </LogSearchProvider>
      </ProcessTreeProvider>
    </ProcessListFilterProvider>
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
// One daemon selected in the tree: the same page, with its row marked.
const daemonRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'daemons/$daemonId',
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
  daemonRoute,
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
