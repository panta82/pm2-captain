import { useNavigate, useParams } from '@tanstack/react-router';
import { ChevronRight, Eye, Plus, RotateCw, Server, Settings2, X } from 'lucide-react';
import { useEffect } from 'react';

import { useProcessListFilter } from '@/lib/process_list_filter';
import { processLink } from '@/lib/process_route';
import { useProcessTree } from '@/lib/process_tree';
import { sumProcesses } from '@/lib/process_tree_rows';
import { trpc } from '@/lib/trpc';
import { cn, formatBytes, formatDuration } from '@/lib/utils';

import { DaemonRetryButton, isDaemonConnecting } from '@/components/daemon_actions';
import { useDaemonManager } from '@/components/daemon_manager';
import { DaemonStatusIcon, daemonColorStyle } from '@/components/daemon_option';
import { ErrorPanel } from '@/components/error_panel';
import { Highlighted } from '@/components/highlighted';
import { ProcessActions } from '@/components/process_actions';
import { ProcessCounts } from '@/components/process_counts';
import { Button, Skeleton } from '@/components/ui';
import {
  DaemonsButton,
  NarrowHeader,
  ProcessListNotice,
  ProcessTreeTools,
  useIsWideLayout,
} from '@/components/workspace';

import type { IDaemonSummary, IProcessSummary } from '@shared/contracts';

function NoDaemons() {
  const daemonManager = useDaemonManager();

  return (
    <div data-component="NoDaemons" className="grid min-h-0 flex-1 place-items-center px-5 py-12">
      <section className="w-full max-w-md rounded-2xl border border-line bg-panel p-7 text-center">
        <Server className="mx-auto size-9 text-muted" aria-hidden />
        <h1 className="mt-4 text-2xl font-bold text-white">No PM2 daemons</h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          Add a PM2 daemon on this computer or on a server reached over SSH.
        </p>
        <div className="mt-6 flex justify-center">
          <Button variant="primary" onClick={() => daemonManager.open('add')}>
            <Plus className="size-4" />
            Add daemon
          </Button>
        </div>
      </section>
    </div>
  );
}

function ProcessTotals({ processes }: { processes: IProcessSummary[] }) {
  const { cpu, memory } = sumProcesses(processes);

  return (
    <span
      data-component="ProcessTotals"
      className="flex shrink-0 items-center gap-4 font-mono text-xs tabular-nums text-muted"
    >
      <span>
        CPU <b className="font-normal text-cyan">{cpu.toFixed(1)}%</b>
      </span>
      <span>
        MEM <b className="font-normal text-[#73a8ff]">{formatBytes(memory)}</b>
      </span>
    </span>
  );
}

/** The top band with Captain selected: everything added up. */
function AllProcessesBand() {
  const { data, listedProcesses } = useProcessTree();
  const { search } = useProcessListFilter();
  const total = data?.processes.length ?? 0;
  const reachableIds = new Set(
    data?.daemons.filter(daemon => daemon.status === 'online').map(daemon => daemon.daemonId)
  );

  return (
    <section
      data-component="AllProcessesBand"
      className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface-menu px-7"
    >
      <h1 className="min-w-0 truncate text-xl font-bold text-white">
        {search
          ? `${listedProcesses.length} of ${total} processes`
          : `${total} process${total === 1 ? '' : 'es'}`}
      </h1>
      <ProcessCounts processes={listedProcesses} className="shrink-0" />
      <ProcessTotals
        processes={listedProcesses.filter(process => reachableIds.has(process.daemonId))}
      />
      <div className="ml-auto">
        <DaemonsButton />
      </div>
    </section>
  );
}

/** The top band with a daemon selected: where it is, how it is doing, and what can be done. */
function DaemonBand({ daemon }: { daemon: IDaemonSummary }) {
  const navigate = useNavigate();
  const { data, locationOf } = useProcessTree();
  const daemonManager = useDaemonManager();
  const processes = (data?.processes ?? []).filter(process => process.daemonId === daemon.daemonId);
  const isOnline = daemon.status === 'online';
  const location = locationOf(daemon.daemonId);

  return (
    <section
      data-component="DaemonBand"
      className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface-menu px-7"
    >
      <DaemonStatusIcon status={daemon.status} color={daemon.color} className="size-4.5" />
      <h1
        className="min-w-0 truncate text-xl font-bold text-white"
        style={daemonColorStyle(daemon.color)}
      >
        {daemon.label}
      </h1>
      {location && location !== daemon.label ? (
        <span className="min-w-0 truncate font-mono text-xs text-muted" title={location}>
          {location}
        </span>
      ) : null}
      {isOnline ? (
        <>
          <ProcessCounts processes={processes} className="shrink-0" />
          <ProcessTotals processes={processes} />
        </>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {!isOnline && !isDaemonConnecting(daemon.status) ? (
          <DaemonRetryButton daemonId={daemon.daemonId} isPrimary />
        ) : null}
        <Button onClick={() => daemonManager.open('daemon', daemon.daemonId)}>
          <Settings2 className="size-4" />
          Edit
        </Button>
        <Button
          variant="ghost"
          className="size-10 p-0"
          aria-label="Close daemon"
          title="Back to every process (Esc)"
          onClick={() => navigate({ to: '/' })}
        >
          <X className="size-4" />
        </Button>
      </div>
    </section>
  );
}

function ProcessCard({
  process,
  color,
  highlight,
  isDaemonAvailable,
}: {
  process: IProcessSummary;
  color: IDaemonSummary['color'];
  highlight: RegExp | null;
  isDaemonAvailable: boolean;
}) {
  const navigate = useNavigate();
  const open = () => navigate(processLink(process.daemonId, [process.pmId]));

  return (
    <article data-component="ProcessCard" className="rounded-xl border border-line bg-panel p-4">
      <button className="block w-full text-left" onClick={open}>
        <div className="flex items-center justify-between gap-3">
          <span
            className="min-w-0 truncate font-semibold text-white"
            style={daemonColorStyle(color)}
          >
            <Highlighted text={process.name} regex={highlight} />
          </span>
          <span
            className={cn(
              'shrink-0 rounded-full border px-2 py-1 font-mono text-[10px] uppercase',
              process.status === 'online'
                ? 'border-online/40 bg-online/10 text-online'
                : 'border-muted/30 text-muted'
            )}
          >
            {process.status}
          </span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3 font-mono text-xs text-muted">
          <span>
            CPU <b className="block pt-1 text-cyan">{process.cpu?.toFixed(1) || '—'}%</b>
          </span>
          <span>
            MEM <b className="block pt-1 text-white">{formatBytes(process.memory)}</b>
          </span>
          <span>
            UP <b className="block pt-1 text-online">{formatDuration(process.uptime)}</b>
          </span>
        </div>
      </button>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
        <span className="font-mono text-xs text-muted">
          id {process.pmId} · pid {process.pid || '—'}
        </span>
        <div className="flex items-center gap-3">
          <ProcessActions process={process} compact daemonAvailable={isDaemonAvailable} />
          <button aria-label={`Open ${process.name}`} onClick={open}>
            <Eye className="size-4 text-cyan" />
          </button>
        </div>
      </div>
    </article>
  );
}

/** A narrow screen has no room for the tree beside anything: it is the page, as cards. */
function ProcessCards() {
  const { rows, highlight, toggleDaemon } = useProcessTree();

  return (
    <main data-component="ProcessCards" className="min-h-0 flex-1 overflow-auto">
      {/* The track may not grow past the screen with a long name, which truncates instead. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-3" data-process-list>
        <ProcessListNotice className="px-1" />
        {rows.map(row =>
          row.kind === 'daemon' ? (
            <button
              key={row.key}
              type="button"
              aria-expanded={row.isOpen}
              className="flex min-w-0 items-center gap-2 px-1 pt-1 text-left font-mono text-xs font-semibold"
              onClick={() => toggleDaemon(row.daemon.daemonId)}
            >
              <ChevronRight
                className={cn('size-3.5 shrink-0 text-muted', row.isOpen && 'rotate-90')}
              />
              <DaemonStatusIcon status={row.daemon.status} color={row.daemon.color} />
              <span
                className="min-w-0 flex-1 truncate text-white"
                style={daemonColorStyle(row.daemon.color)}
              >
                {row.daemon.label}
              </span>
              <ProcessCounts processes={row.processes} className="shrink-0 font-normal" />
            </button>
          ) : (
            <ProcessCard
              key={row.key}
              process={row.process}
              color={row.daemon.color}
              highlight={highlight}
              isDaemonAvailable={row.daemon.status === 'online'}
            />
          )
        )}
      </div>
    </main>
  );
}

/**
 * The page for Captain or a daemon in the tree. On a wide screen that is the top
 * band, above the tree's own columns. The other states of the list get the room.
 */
export function StatusPage() {
  const navigate = useNavigate();
  const isWide = useIsWideLayout();
  const routeDaemonId = useParams({ strict: false, select: params => params.daemonId });
  const query = trpc.processes.list.useQuery(undefined, { refetchInterval: 2_000 });
  const daemon = query.data?.daemons.find(candidate => candidate.daemonId === routeDaemonId);
  const isDaemonGone = Boolean(routeDaemonId && query.data && !daemon);

  useEffect(() => {
    if (isDaemonGone) {
      void navigate({ to: '/', replace: true });
    }
  }, [isDaemonGone, navigate]);

  if (query.isLoading) {
    return (
      <div data-component="StatusPage" className="space-y-px p-4">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (query.error) {
    return (
      <div data-component="StatusPage" className="flex min-h-0 flex-1 flex-col">
        <ErrorPanel title="Unable to reach PM2" message={query.error.message}>
          <Button variant="primary" onClick={() => void query.refetch()}>
            <RotateCw className="size-4" />
            Try again
          </Button>
        </ErrorPanel>
      </div>
    );
  }

  if (query.data && !query.data.daemons.length) {
    return <NoDaemons />;
  }

  if (isWide) {
    return daemon ? <DaemonBand daemon={daemon} /> : <AllProcessesBand />;
  }

  return (
    <div data-component="StatusPage" className="flex min-h-0 flex-1 flex-col">
      <NarrowHeader />
      <ProcessTreeTools className="h-detail-toolbar shrink-0 border-b border-line bg-surface-control px-3" />
      <ProcessCards />
    </div>
  );
}
