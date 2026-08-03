import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';

import { useDebouncedSearch } from '@/lib/debounce';
import { ProcessListFilterProvider } from '@/lib/process_list_filter';
import { trpc } from '@/lib/trpc';

import { AppHeader } from '@/components/app_header';
import { RestartOverlay } from '@/components/restart_overlay';
import { SearchFilter } from '@/components/search_filter';

import { EnvPage } from '@/pages/env_page';
import { ErrorPage } from '@/pages/error_page';
import { InfoPage } from '@/pages/info_page';
import { LogsPage } from '@/pages/logs_page';
import { NotFoundPage } from '@/pages/not_found_page';
import { ProcessLayout } from '@/pages/process_layout';
import { StatusPage } from '@/pages/status_page';

const SEARCH_DEBOUNCE_MS = 300;

function RootLayout() {
  const list = trpc.processes.list.useQuery(undefined, { refetchInterval: 2_000 });
  const processDetailOpen = useRouterState({
    select: state => state.location.pathname.startsWith('/processes/'),
  });
  const {
    draft: searchDraft,
    value: search,
    phase: searchPhase,
    setDraft: setSearchDraft,
  } = useDebouncedSearch(SEARCH_DEBOUNCE_MS);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);

  useEffect(() => {
    document.title = list.data?.hostname ? `${list.data.hostname} — PM2 Captain` : 'PM2 Captain';
  }, [list.data?.hostname]);

  return (
    <ProcessListFilterProvider value={{ search, caseSensitive, regex }}>
      <div
        data-component="RootLayout"
        className="flex h-svh min-h-0 flex-col overflow-hidden bg-navy text-white"
      >
        {!processDetailOpen ? (
          <AppHeader
            data={list.data}
            loading={list.isPending && !list.data}
            failed={list.isError}
            filter={
              <SearchFilter
                draft={searchDraft}
                phase={searchPhase}
                onDraftChange={setSearchDraft}
                caseSensitive={caseSensitive}
                onCaseSensitiveChange={setCaseSensitive}
                regex={regex}
                onRegexChange={setRegex}
                placeholder="Filter processes…"
                className="w-full max-w-none sm:w-full"
              />
            }
          />
        ) : null}
        <Outlet />
        <RestartOverlay />
        <Toaster
          theme="dark"
          position="bottom-left"
          toastOptions={{
            style: {
              background: '#0b263b',
              border: '1px solid #153b55',
              color: '#fff',
            },
          }}
        />
      </div>
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
const processRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'processes/$pmId',
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
