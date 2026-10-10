import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { Menu, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useFilteredProcesses } from '@/lib/process_list_filter';
import { setProcessTab } from '@/lib/process_tab';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import { AppHeader } from '@/components/app_header';
import { ErrorPanel } from '@/components/error_panel';
import { ProcessActions } from '@/components/process_actions';
import { ProcessFilterField } from '@/components/process_filter_field';
import { ProcessNav } from '@/components/process_nav';
import { ResizableSidebar } from '@/components/resizable_sidebar';
import { TruncatedText } from '@/components/truncated_text';
import { Button, Skeleton } from '@/components/ui';

export function ProcessLayout() {
  const { daemonId, pmId } = useParams({ from: '/daemons/$daemonId/processes/$pmId' });
  const numericId = Number(pmId);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: state => state.location.pathname });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const list = trpc.processes.list.useQuery(undefined, { refetchInterval: 2_000 });
  const detail = trpc.processes.detail.useQuery(
    { daemonId, pmId: numericId },
    {
      refetchInterval: query => (query.state.error ? false : 2_000),
      retry: (failureCount, error) => error.data?.code !== 'NOT_FOUND' && failureCount < 2,
    }
  );

  useEffect(() => {
    if (pathname.endsWith('/logs')) {
      setProcessTab('logs');
    } else if (pathname.endsWith('/env')) {
      setProcessTab('env');
    } else if (pathname.endsWith('/info')) {
      setProcessTab('info');
    }
  }, [pathname]);

  useEffect(() => {
    if (detail.error?.data?.code === 'NOT_FOUND') {
      void navigate({ to: '/', replace: true });
    }
  }, [detail.error, navigate]);

  const listProcess = list.data?.processes.find(
    process => process.daemonId === daemonId && process.pmId === numericId
  );
  const process = detail.data ?? listProcess;
  const selectedDaemon = list.data?.daemons.find(daemon => daemon.daemonId === daemonId);
  const daemonProcesses = useMemo(
    () => (list.data?.processes || []).filter(process => process.daemonId === daemonId),
    [list.data?.processes, daemonId]
  );
  const filtered = useFilteredProcesses(daemonProcesses);
  const listNotice =
    filtered.error || (filtered.processes.length ? null : 'No processes match the filter.');
  const listNoticeElement = listNotice ? (
    <p className={cn('px-4 pt-4 font-mono text-xs', filtered.error ? 'text-danger' : 'text-muted')}>
      {listNotice}
    </p>
  ) : null;

  if (list.isLoading && !list.data) {
    return (
      <div data-component="ProcessLayout" className="m-6 h-72">
        <Skeleton className="h-full" />
      </div>
    );
  }

  if (!list.data) {
    return (
      <div data-component="ProcessLayout" className="flex min-h-0 flex-1 flex-col">
        <ErrorPanel
          title="Unable to load processes"
          message={list.error?.message || 'Failed to load the PM2 process list.'}
        >
          <Button variant="primary" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </ErrorPanel>
      </div>
    );
  }

  if (!process && !detail.isLoading) {
    const isDaemonUnavailable = detail.error?.data?.code === 'PRECONDITION_FAILED';
    return (
      <div data-component="ProcessLayout" className="flex min-h-0 flex-1 flex-col">
        <ErrorPanel
          title={isDaemonUnavailable ? 'Daemon unavailable' : 'Process not found'}
          message={detail.error?.message || 'This process is not in the current PM2 list.'}
        >
          {isDaemonUnavailable ? (
            <>
              <Button variant="primary" onClick={() => void detail.refetch()}>
                Try again
              </Button>
              <Button onClick={() => void navigate({ to: '/' })}>Go home</Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => void navigate({ to: '/' })}>
              Go home
            </Button>
          )}
        </ErrorPanel>
      </div>
    );
  }

  return (
    <div data-component="ProcessLayout" className="flex min-h-0 flex-1">
      <ResizableSidebar className="hidden min-h-0 shrink-0 flex-col self-stretch overflow-hidden border-r border-line bg-surface-plane lg:flex">
        <AppHeader data={list.data} loading={false} failed={false} sidebar />
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-detail-toolbar shrink-0 items-center border-b border-line bg-surface-control px-3">
            <ProcessFilterField />
          </div>
          {listNoticeElement}
          <ProcessNav
            processes={filtered.processes}
            highlight={filtered.highlight}
            selectedDaemonId={daemonId}
            selectedId={numericId}
            autoFocus
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3"
            itemClassName="relative mx-2 flex h-12 items-center gap-3 rounded-lg px-3 text-sm"
            selectedItemClassName="border border-primary/50 bg-panel-hover text-white"
            idleItemClassName="border border-transparent text-white/90 hover:bg-panel"
            leading={(_process, isSelected) =>
              isSelected ? (
                <i className="absolute -left-[9px] h-7 w-1 rounded-r bg-primary" />
              ) : null
            }
          />
        </div>
      </ResizableSidebar>
      {mobileMenuOpen ? (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <button
            className="absolute inset-0 bg-black/70"
            aria-label="Close process menu"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative h-full w-[min(82vw,320px)] overflow-y-auto border-r border-line bg-surface-plane p-3">
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
            <ProcessFilterField className="mb-3" />
            {listNoticeElement}
            <ProcessNav
              processes={filtered.processes}
              highlight={filtered.highlight}
              selectedDaemonId={daemonId}
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
        <section className="flex h-auto shrink-0 flex-col border-b border-line bg-surface-menu px-4 sm:px-7 lg:h-16 lg:justify-end">
          <div className="flex flex-col gap-2 py-3 sm:grid sm:min-h-16 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-end sm:gap-x-3 sm:py-0 lg:min-h-0 lg:h-full">
            <div className="flex min-w-0 items-center gap-3 sm:self-center">
              <Button
                variant="ghost"
                className="size-9 shrink-0 p-0 lg:hidden"
                onClick={() => setMobileMenuOpen(true)}
              >
                <Menu className="size-4" />
              </Button>
              {process ? (
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <i
                    className={cn(
                      'size-2 shrink-0 self-center rounded-full',
                      process.status === 'online'
                        ? 'bg-online shadow-[0_0_9px_#35D07F]'
                        : 'border border-muted'
                    )}
                  />
                  <h1 className="min-w-0 text-md font-bold text-white sm:text-xl">
                    <TruncatedText text={process.name} />
                  </h1>
                </div>
              ) : (
                <Skeleton className="h-7 w-48" />
              )}
              <Button
                variant="ghost"
                className="size-10 shrink-0 p-0 sm:hidden"
                aria-label="Close process"
                onClick={() => navigate({ to: '/' })}
              >
                <X className="size-4" />
              </Button>
            </div>

            <div className="flex items-center justify-center gap-2 sm:col-start-3 sm:justify-end sm:self-center">
              {process ? (
                <>
                  <div className="sm:hidden">
                    <ProcessActions
                      process={process}
                      compact
                      daemonAvailable={selectedDaemon?.status === 'online'}
                    />
                  </div>
                  <div className="hidden sm:block">
                    <ProcessActions
                      process={process}
                      daemonAvailable={selectedDaemon?.status === 'online'}
                    />
                  </div>
                </>
              ) : null}
              <Button
                variant="ghost"
                className="hidden size-10 p-0 sm:inline-flex"
                aria-label="Close process"
                onClick={() => navigate({ to: '/' })}
              >
                <X className="size-4" />
              </Button>
            </div>

            <nav className="flex justify-center sm:col-start-2 sm:row-start-1">
              {/* The active tab is a cut-out onto whatever lies under the header. */}
              <div
                className={cn(
                  'relative top-px flex overflow-hidden rounded-t-lg border border-b-0 border-line',
                  pathname.endsWith('/logs') ? 'bg-surface-control' : 'bg-surface-plane'
                )}
              >
                <Link
                  to="/daemons/$daemonId/processes/$pmId/info"
                  params={{ daemonId, pmId }}
                  onClick={() => setProcessTab('info')}
                  activeProps={{ className: 'border-b-transparent text-cyan' }}
                  inactiveProps={{
                    className:
                      'border-b-line bg-surface-menu text-control-muted hover:bg-panel hover:text-white',
                  }}
                  className="border-b px-5 py-2.5 text-sm font-semibold"
                >
                  Info
                </Link>
                <Link
                  to="/daemons/$daemonId/processes/$pmId/env"
                  params={{ daemonId, pmId }}
                  onClick={() => setProcessTab('env')}
                  activeProps={{ className: 'border-b-transparent text-cyan' }}
                  inactiveProps={{
                    className:
                      'border-b-line bg-surface-menu text-control-muted hover:bg-panel hover:text-white',
                  }}
                  className="border-b border-l border-line px-5 py-2.5 text-sm font-semibold"
                >
                  Env
                </Link>
                <Link
                  to="/daemons/$daemonId/processes/$pmId/logs"
                  params={{ daemonId, pmId }}
                  onClick={() => setProcessTab('logs')}
                  activeProps={{ className: 'border-b-transparent text-cyan' }}
                  inactiveProps={{
                    className:
                      'border-b-line bg-surface-menu text-control-muted hover:bg-panel hover:text-white',
                  }}
                  className="border-b border-l border-line px-5 py-2.5 text-sm font-semibold"
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
