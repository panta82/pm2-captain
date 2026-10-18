import { Link, useNavigate } from '@tanstack/react-router';
import { Menu, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { BulkActionProvider } from '@/lib/bulk_action';
import { useConnectionReplaced } from '@/lib/daemon_connection';
import { useFilteredProcesses } from '@/lib/process_list_filter';
import { getProcessTab, processLink, processRouteApi, setProcessTab } from '@/lib/process_route';
import { formatPmIds } from '@/lib/process_selection';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import { AppHeader } from '@/components/app_header';
import { BulkProcessActions } from '@/components/bulk_process_actions';
import { ErrorPanel } from '@/components/error_panel';
import { ProcessActions } from '@/components/process_actions';
import { ProcessCounts } from '@/components/process_counts';
import { ProcessFilterField } from '@/components/process_filter_field';
import { ProcessNav } from '@/components/process_nav';
import { ProcessTabs } from '@/components/process_tabs';
import { ResizableSidebar } from '@/components/resizable_sidebar';
import { TruncatedText } from '@/components/truncated_text';
import { Button, Skeleton } from '@/components/ui';

export function ProcessLayout() {
  // Structural sharing keeps `pmIds` stable while only the tab changes.
  const { daemonId, pmIds, tab } = processRouteApi.useParams({ structuralSharing: true });
  // The route guarantees at least one PM2 ID; several once more processes are selected.
  const isMulti = pmIds.length > 1;
  const numericId = pmIds[0] ?? 0;
  const selectionKey = formatPmIds(pmIds);
  const navigate = useNavigate();
  // A multi-selection can be on Info while the remembered single-process tab is Logs.
  const sidebarTab = isMulti ? getProcessTab() : tab;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const list = trpc.processes.list.useQuery(undefined, { refetchInterval: 2_000 });
  const connectionId = list.data?.daemons.find(
    daemon => daemon.daemonId === daemonId
  )?.connectionId;
  const detail = trpc.processes.detail.useQuery(
    { daemonId, connectionId, pmId: numericId },
    {
      enabled: pmIds.length === 1 && connectionId !== undefined,
      refetchInterval: query => (query.state.error ? false : 2_000),
      retry: (failureCount, error) => error.data?.code !== 'NOT_FOUND' && failureCount < 2,
    }
  );

  useEffect(() => {
    // A selection is moved off the Logs tab; that must not replace the remembered tab.
    if (!isMulti) {
      setProcessTab(tab);
    }
  }, [isMulti, tab]);

  // The selected PM2 IDs belonged to the daemon's previous location. They may
  // name other processes now, so the page goes back to the daemon's status.
  useConnectionReplaced(daemonId, connectionId, () => {
    toast.info('The daemon was reconfigured. Showing its processes.');
    void navigate({ to: '/', replace: true });
  });

  useEffect(() => {
    // For a selection the list decides: a process that is gone only leaves the selection.
    if (!isMulti && detail.error?.data?.code === 'NOT_FOUND') {
      void navigate({ to: '/', replace: true });
    }
  }, [detail.error, isMulti, navigate]);

  const listProcess = list.data?.processes.find(
    process => process.daemonId === daemonId && process.pmId === numericId
  );
  const process = detail.data ?? listProcess;
  const selectedDaemon = list.data?.daemons.find(daemon => daemon.daemonId === daemonId);
  const daemonProcesses = useMemo(
    () => (list.data?.processes || []).filter(process => process.daemonId === daemonId),
    [list.data?.processes, daemonId]
  );
  const selectedProcesses = useMemo(
    () => daemonProcesses.filter(process => pmIds.includes(process.pmId)),
    [daemonProcesses, pmIds]
  );
  const isListLoaded = Boolean(list.data);

  useEffect(() => {
    if (!isMulti || !isListLoaded) {
      return;
    }
    if (!selectedProcesses.length) {
      void navigate({ to: '/', replace: true });
      return;
    }
    // A process that left the PM2 list leaves the selection too.
    if (selectedProcesses.length < pmIds.length) {
      void navigate({
        ...processLink(
          daemonId,
          selectedProcesses.map(process => process.pmId),
          tab
        ),
        replace: true,
      });
    }
  }, [daemonId, isListLoaded, isMulti, navigate, pmIds, selectedProcesses, tab]);

  const filtered = useFilteredProcesses(daemonProcesses);
  const visibleProcesses = useMemo(() => {
    // Keep every action target visible, in the daemon's normal process order.
    const visibleIds = new Set([...pmIds, ...filtered.processes.map(process => process.pmId)]);
    return daemonProcesses.filter(process => visibleIds.has(process.pmId));
  }, [daemonProcesses, filtered.processes, pmIds]);
  const listNotice =
    filtered.error || (visibleProcesses.length ? null : 'No processes match the filter.');
  const listNoticeElement = listNotice ? (
    <p className={cn('px-4 pt-4 font-mono text-xs', filtered.error ? 'text-danger' : 'text-muted')}>
      {listNotice}
    </p>
  ) : null;

  if ((list.isLoading && !list.data) || (isMulti && !selectedProcesses.length && list.data)) {
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

  if (!isMulti && !process && !detail.isLoading) {
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

  const isDaemonAvailable = selectedDaemon?.status === 'online';

  return (
    <BulkActionProvider daemonId={daemonId} connectionId={connectionId}>
      <div data-component="ProcessLayout" className="flex min-h-0 flex-1">
        <ResizableSidebar className="hidden min-h-0 shrink-0 flex-col self-stretch overflow-hidden border-r border-line bg-surface-plane lg:flex">
          <AppHeader data={list.data} loading={false} failed={false} sidebar />
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-detail-toolbar shrink-0 items-center border-b border-line bg-surface-control px-3">
              <ProcessFilterField />
            </div>
            {listNoticeElement}
            <ProcessNav
              processes={visibleProcesses}
              highlight={filtered.highlight}
              selectedDaemonId={daemonId}
              selectedIds={pmIds}
              tab={sidebarTab}
              autoFocus
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3"
              itemClassName="flex h-12 items-center text-sm"
              selectedItemClassName="bg-panel-hover text-white hover:brightness-110 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.07),inset_0_-1px_0_rgb(0_0_0_/_0.4)]"
              idleItemClassName="text-white/90 hover:bg-panel"
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
                processes={visibleProcesses}
                highlight={filtered.highlight}
                selectedDaemonId={daemonId}
                selectedIds={pmIds}
                tab={sidebarTab}
                autoFocus
                onItemClick={() => setMobileMenuOpen(false)}
                itemClassName="mb-1 flex h-11 items-center rounded-lg text-sm"
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
            <div
              className={cn(
                'flex flex-col gap-2 py-3 sm:grid sm:min-h-16 sm:items-end sm:gap-x-3 sm:py-0 lg:h-full lg:min-h-0',
                // Below xl the three buttons of a selection leave no room to center the tabs.
                isMulti
                  ? 'sm:grid-cols-[minmax(0,1fr)_auto_auto] xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]'
                  : 'sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]'
              )}
            >
              <div className="flex min-w-0 items-center gap-3 sm:self-center">
                <Button
                  variant="ghost"
                  className="size-9 shrink-0 p-0 lg:hidden"
                  onClick={() => setMobileMenuOpen(true)}
                >
                  <Menu className="size-4" />
                </Button>
                {isMulti ? (
                  <div className="flex min-w-0 flex-1 items-center gap-4">
                    <h1 className="min-w-0 truncate text-md font-bold text-white sm:text-xl">
                      {selectedProcesses.length} processes
                    </h1>
                    <ProcessCounts processes={selectedProcesses} className="shrink-0" />
                  </div>
                ) : process ? (
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
                  aria-label={isMulti ? 'Close selection' : 'Close process'}
                  onClick={() => navigate({ to: '/' })}
                >
                  <X className="size-4" />
                </Button>
              </div>

              <div className="flex items-center justify-center gap-2 sm:col-start-3 sm:justify-end sm:self-center">
                {isMulti ? (
                  <>
                    {/* Three counted buttons need more room than the two of one process. */}
                    <div className="2xl:hidden">
                      <BulkProcessActions
                        processes={selectedProcesses}
                        compact
                        daemonAvailable={isDaemonAvailable}
                      />
                    </div>
                    <div className="hidden 2xl:block">
                      <BulkProcessActions
                        processes={selectedProcesses}
                        daemonAvailable={isDaemonAvailable}
                      />
                    </div>
                  </>
                ) : process ? (
                  <>
                    <div className="sm:hidden">
                      <ProcessActions
                        process={process}
                        compact
                        daemonAvailable={isDaemonAvailable}
                      />
                    </div>
                    <div className="hidden sm:block">
                      <ProcessActions process={process} daemonAvailable={isDaemonAvailable} />
                    </div>
                  </>
                ) : null}
                <Button
                  variant="ghost"
                  className="hidden size-10 p-0 sm:inline-flex"
                  aria-label={isMulti ? 'Close selection' : 'Close process'}
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
                    tab === 'logs' || isMulti ? 'bg-surface-control' : 'bg-surface-plane'
                  )}
                >
                  <Link
                    {...processLink(daemonId, pmIds, 'info')}
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
                    {...processLink(daemonId, pmIds, 'env')}
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
                  {isMulti ? null : (
                    <Link
                      {...processLink(daemonId, pmIds, 'logs')}
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
                  )}
                </div>
              </nav>
            </div>
          </section>
          <ProcessTabs selectionKey={`${daemonId}:${selectionKey}`} tab={tab} />
        </main>
      </div>
    </BulkActionProvider>
  );
}
