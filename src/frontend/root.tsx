import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { Toaster } from 'sonner';

import { AppHeader } from '@/components/app_header';
import { RestartOverlay } from '@/components/restart_overlay';
import { trpc } from '@/lib/trpc';
import { InfoPage } from '@/pages/info_page';
import { LogsPage } from '@/pages/logs_page';
import { ProcessLayout } from '@/pages/process_layout';
import { StatusPage } from '@/pages/status_page';

function RootLayout() {
  const list = trpc.processes.list.useQuery(undefined, { refetchInterval: 2_000 });
  return (
    <div className="flex h-svh min-h-0 flex-col overflow-hidden bg-navy text-white">
      <AppHeader data={list.data} />
      <Outlet />
      <RestartOverlay />
      <Toaster
        theme="dark"
        position="top-right"
        toastOptions={{
          style: {
            background: '#0b263b',
            border: '1px solid #153b55',
            color: '#fff',
          },
        }}
      />
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });
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
const logsRoute = createRoute({
  getParentRoute: () => processRoute,
  path: 'logs',
  component: LogsPage,
});

const routeTree = rootRoute.addChildren([
  statusRoute,
  processRoute.addChildren([infoRoute, logsRoute]),
]);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function Root() {
  return <RouterProvider router={router} />;
}
