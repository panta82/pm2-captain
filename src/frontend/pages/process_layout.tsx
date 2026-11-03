import { Link, useNavigate } from '@tanstack/react-router';
import { Menu, X } from 'lucide-react';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { BulkActionProvider } from '@/lib/bulk_action';
import { useConnectionReplaced } from '@/lib/daemon_connection';
import { focusProcessList, useShortcutAria, useShortcutHandler } from '@/lib/keyboard_shortcuts';
import {
  daemonLink,
  getProcessTab,
  processLink,
  processRouteApi,
  setProcessTab,
} from '@/lib/process_route';
import { formatPmIds } from '@/lib/process_selection';
import { useProcessTree } from '@/lib/process_tree';
import { type IProcessTreeRow, processRowKey } from '@/lib/process_tree_rows';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import { BulkProcessActions } from '@/components/bulk_process_actions';
import { daemonColorStyle } from '@/components/daemon_option';
import { ErrorPanel } from '@/components/error_panel';
import { ProcessActions } from '@/components/process_actions';
import { ProcessCounts } from '@/components/process_counts';
import { ProcessTabs } from '@/components/process_tabs';
import { ProcessTree } from '@/components/process_tree';
import { ShortcutHint } from '@/components/shortcut_hint';
import { TruncatedText } from '@/components/truncated_text';
import { Button, Skeleton } from '@/components/ui';
import { NarrowHeader, ProcessListNotice, ProcessTreeTools } from '@/components/workspace';

/** The open process or selection, next to the tree. */
export function ProcessLayout() {
  // Structural sharing keeps `pmIds` stable while only the tab changes.
  const { daemonId, pmIds, tab } = processRouteApi.useParams({ structuralSharing: true });
  // The route guarantees at least one PM2 ID; several once more processes are selected.
  const isMulti = pmIds.length > 1;
  const numericId = pmIds[0] ?? 0;
  const selectionKey = formatPmIds(pmIds);
  const navigate = useNavigate();
  const tree = useProcessTree();
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
  const selectedProcesses = useMemo(
    () =>
      (list.data?.processes || []).filter(
        process => process.daemonId === daemonId && pmIds.includes(process.pmId)
      ),
    [daemonId, list.data?.processes, pmIds]
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

  // Ctrl+Down and Ctrl+Up move to the process after or before the selection, in
  // the tree's order, over to the next daemon if need be, and focus the tree,
  // where the arrow keys go on.
  useShortcutHandler(['process.next', 'process.previous'], actionId => {
    const processRows = tree.rows.filter((row): row is IProcessTreeRow => row.kind === 'process');
    const selectedKeys = new Set(pmIds.map(pmId => processRowKey(daemonId, pmId)));
    const selectedIndexes = processRows.flatMap((row, index) =>
      selectedKeys.has(row.key) ? [index] : []
    );
    if (!selectedIndexes.length) {
      return false;
    }
    const nextIndex =
      actionId === 'process.next'
        ? Math.min(Math.max(...selectedIndexes) + 1, processRows.length - 1)
        : Math.max(Math.min(...selectedIndexes) - 1, 0);
    const next = processRows[nextIndex].process;
    void navigate(processLink(next.daemonId, [next.pmId], isMulti ? getProcessTab() : tab));
    focusProcessList();
  });
  const tabShortcuts = {
    info: useShortcutAria('tab.info'),
    env: useShortcutAria('tab.env'),
    logs: useShortcutAria('tab.logs'),
  };

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
  const daemonCrumb = selectedDaemon ? (
    <>
      <Link
        {...daemonLink(daemonId)}
        title={`Show ${selectedDaemon.label}`}
        className="hidden max-w-48 shrink truncate font-mono text-xs text-muted hover:text-white hover:underline sm:block"
        style={daemonColorStyle(selectedDaemon.color)}
      >
        {selectedDaemon.label}
      </Link>
      <span aria-hidden className="hidden text-lg text-line sm:block">
        /
      </span>
    </>
  ) : null;

  return (
    <BulkActionProvider daemonId={daemonId} connectionId={connectionId}>
      <div data-component="ProcessLayout" className="flex min-h-0 flex-1">
        {mobileMenuOpen ? (
          <div className="fixed inset-0 z-40 flex lg:hidden">
            <button
              className="absolute inset-0 bg-black/70"
              aria-label="Close process menu"
              onClick={() => setMobileMenuOpen(false)}
            />
            <div
              data-tree-scroller
              // Here, the rows are as wide as this menu, not the side menu of a wide screen.
              style={{ '--sidebar-width': '100%' } as CSSProperties}
              className="relative h-full w-[min(82vw,320px)] overflow-y-auto border-r border-line bg-surface-plane p-3 [overflow-anchor:none]"
            >
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
              <ProcessTreeTools className="mb-3" />
              <ProcessListNotice className="px-4 pb-4" />
              <ProcessTree autoFocus onItemClick={() => setMobileMenuOpen(false)} />
            </div>
          </div>
        ) : null}
        <main
          className="flex min-w-0 flex-1 flex-col overflow-hidden"
          // Escape in the open process goes back to the process list, unless
          // something in it used the key, such as a search box with text.
          onKeyDown={event => {
            const hasModifier = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
            if (
              event.key === 'Escape' &&
              !event.defaultPrevented &&
              !hasModifier &&
              focusProcessList()
            ) {
              event.preventDefault();
            }
          }}
        >
          <div className="lg:hidden">
            <NarrowHeader />
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
                {daemonCrumb}
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
                  onClick={() => navigate(tree.closeLink)}
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
                        hasShortcut
                      />
                    </div>
                    <div className="hidden sm:block">
                      <ProcessActions
                        process={process}
                        daemonAvailable={isDaemonAvailable}
                        hasShortcut
                      />
                    </div>
                  </>
                ) : null}
                <Button
                  variant="ghost"
                  className="hidden size-10 p-0 sm:inline-flex"
                  aria-label={isMulti ? 'Close selection' : 'Close process'}
                  onClick={() => navigate(tree.closeLink)}
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
                    className="relative border-b px-5 py-2.5 text-sm font-semibold"
                    data-shortcut="tab.info"
                    aria-keyshortcuts={tabShortcuts.info}
                  >
                    Info
                    <ShortcutHint
                      action="tab.info"
                      className="top-1/2 right-0.5 -translate-y-1/2 px-1"
                    />
                  </Link>
                  <Link
                    {...processLink(daemonId, pmIds, 'env')}
                    onClick={() => setProcessTab('env')}
                    activeProps={{ className: 'border-b-transparent text-cyan' }}
                    inactiveProps={{
                      className:
                        'border-b-line bg-surface-menu text-control-muted hover:bg-panel hover:text-white',
                    }}
                    className="relative border-b border-l border-line px-5 py-2.5 text-sm font-semibold"
                    data-shortcut="tab.env"
                    aria-keyshortcuts={tabShortcuts.env}
                  >
                    Env
                    <ShortcutHint
                      action="tab.env"
                      className="top-1/2 right-0.5 -translate-y-1/2 px-1"
                    />
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
                      className="relative border-b border-l border-line px-5 py-2.5 text-sm font-semibold"
                      data-shortcut="tab.logs"
                      aria-keyshortcuts={tabShortcuts.logs}
                    >
                      Logs
                      <ShortcutHint
                        action="tab.logs"
                        className="top-1/2 right-0.5 -translate-y-1/2 px-1"
                      />
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
