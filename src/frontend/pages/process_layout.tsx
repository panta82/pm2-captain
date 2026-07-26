import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { setProcessTab } from '@/lib/process_tab';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import { AppHeader } from '@/components/app_header';
import { ProcessActions } from '@/components/process_actions';
import { ProcessNav } from '@/components/process_nav';
import { Button, Skeleton } from '@/components/ui';

export function ProcessLayout() {
  const { pmId } = useParams({ from: '/processes/$pmId' });
  const numericId = Number(pmId);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: state => state.location.pathname });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const list = trpc.processes.list.useQuery(undefined, { refetchInterval: 2_000 });
  const detail = trpc.processes.detail.useQuery(
    { pmId: numericId },
    {
      refetchInterval: query => (query.state.error ? false : 2_000),
      retry: (failureCount, error) => error.data?.code !== 'NOT_FOUND' && failureCount < 2,
    }
  );

  useEffect(() => {
    if (pathname.endsWith('/logs')) {
      setProcessTab('logs');
    } else if (pathname.endsWith('/info')) {
      setProcessTab('info');
    }
  }, [pathname]);

  useEffect(() => {
    if (detail.error?.data?.code === 'NOT_FOUND') {
      void navigate({ to: '/', replace: true });
    }
  }, [detail.error, navigate]);

  const listProcess = list.data?.processes.find(process => process.pmId === numericId);
  const process = detail.data ?? listProcess;

  if (list.isLoading && !list.data) {
    return (
      <div data-component="ProcessLayout" className="m-6 h-72">
        <Skeleton className="h-full" />
      </div>
    );
  }

  if (!list.data) {
    return (
      <div data-component="ProcessLayout" className="grid flex-1 place-items-center text-danger">
        {list.error?.message || 'Unable to load processes'}
      </div>
    );
  }

  if (!process && !detail.isLoading) {
    return (
      <div data-component="ProcessLayout" className="grid flex-1 place-items-center text-danger">
        {detail.error?.message || 'Process not found'}
      </div>
    );
  }

  return (
    <div data-component="ProcessLayout" className="flex min-h-0 flex-1">
      <aside className="hidden w-[244px] shrink-0 border-r border-line bg-topbar lg:block">
        <AppHeader data={list.data} loading={false} failed={false} sidebar />
        <ProcessNav
          processes={list.data.processes}
          selectedId={numericId}
          autoFocus
          className="py-3"
          itemClassName="relative mx-2 flex h-12 items-center gap-3 rounded-lg px-3 text-sm transition-colors"
          selectedItemClassName="border border-primary/50 bg-panel-hover text-white"
          idleItemClassName="border border-transparent text-white/90 hover:bg-panel"
          leading={(_process, isSelected) =>
            isSelected ? <i className="absolute -left-[9px] h-7 w-1 rounded-r bg-primary" /> : null
          }
        />
      </aside>
      {mobileMenuOpen ? (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <button
            className="absolute inset-0 bg-black/70"
            aria-label="Close process menu"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative h-full w-[min(82vw,320px)] overflow-y-auto border-r border-line bg-topbar p-3">
            <div className="mb-3 flex items-center justify-between px-2">
              <span className="text-sm font-semibold">Processes</span>
              <Button
                variant="ghost"
                className="size-9 p-0"
                onClick={() => setMobileMenuOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <ProcessNav
              processes={list.data.processes}
              selectedId={numericId}
              autoFocus
              onItemClick={() => setMobileMenuOpen(false)}
              itemClassName="mb-1 flex h-11 items-center gap-3 rounded-lg px-3 text-sm"
              selectedItemClassName="bg-panel-hover text-white"
              idleItemClassName="text-muted"
            />
          </div>
        </div>
      ) : null}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="lg:hidden">
          <AppHeader data={list.data} loading={false} failed={false} />
        </div>
        <section className="shrink-0 border-b border-line bg-panel/45 px-4 sm:h-16 sm:px-7">
          <div className="grid h-full grid-cols-[minmax(0,1fr)_auto] items-end gap-x-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <div className="flex min-w-0 items-center gap-3 self-center py-3 sm:py-0">
              <Button
                variant="ghost"
                className="size-9 shrink-0 p-0 lg:hidden"
                onClick={() => setMobileMenuOpen(true)}
              >
                <Menu className="size-4" />
              </Button>
              {process ? (
                <div className="flex min-w-0 items-center gap-3">
                  <i
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      process.status === 'online'
                        ? 'bg-online shadow-[0_0_9px_#35D07F]'
                        : 'border border-muted'
                    )}
                  />
                  <h1 className="truncate text-xl font-bold text-white sm:text-2xl">
                    {process.name}
                  </h1>
                </div>
              ) : (
                <Skeleton className="h-7 w-48" />
              )}
            </div>

            <div className="flex items-center justify-end gap-2 self-center py-3 sm:col-start-3 sm:py-0">
              {process ? (
                <>
                  <div className="sm:hidden">
                    <ProcessActions process={process} compact />
                  </div>
                  <div className="hidden sm:block">
                    <ProcessActions process={process} />
                  </div>
                </>
              ) : null}
              <Button
                variant="ghost"
                className="size-10 p-0"
                aria-label="Close process"
                onClick={() => navigate({ to: '/' })}
              >
                <X className="size-4" />
              </Button>
            </div>

            <nav className="col-span-2 flex justify-center sm:col-span-1 sm:col-start-2 sm:row-start-1">
              <div className="relative top-px flex overflow-hidden rounded-t-lg border border-b-0 border-line bg-navy">
                <Link
                  to="/processes/$pmId/info"
                  params={{ pmId }}
                  onClick={() => setProcessTab('info')}
                  activeProps={{ className: 'border-b-transparent text-cyan' }}
                  inactiveProps={{
                    className:
                      'border-b-line bg-panel/55 text-muted hover:bg-panel/40 hover:text-white',
                  }}
                  className="border-b px-5 py-2.5 text-sm font-semibold transition-colors"
                >
                  Info
                </Link>
                <Link
                  to="/processes/$pmId/logs"
                  params={{ pmId }}
                  onClick={() => setProcessTab('logs')}
                  activeProps={{ className: 'border-b-transparent text-cyan' }}
                  inactiveProps={{
                    className:
                      'border-b-line bg-panel/55 text-muted hover:bg-panel/40 hover:text-white',
                  }}
                  className="border-b border-l border-line px-5 py-2.5 text-sm font-semibold transition-colors"
                >
                  Logs
                </Link>
              </div>
            </nav>
          </div>
        </section>
        <Outlet />
      </main>
    </div>
  );
}
