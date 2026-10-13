import { useParams } from '@tanstack/react-router';
import { Check, LoaderCircle, TriangleAlert } from 'lucide-react';

import { useBulkAction } from '@/lib/bulk_action';
import { parsePmIds } from '@/lib/process_selection';
import { trpc } from '@/lib/trpc';
import { compactPath, formatBytes, formatDuration } from '@/lib/utils';

import { ProcessMatrix, ProcessMatrixError } from '@/components/process_matrix';

import type { IProcessDetail } from '@shared/contracts';

function Metric({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div data-component="Metric" className="rounded-xl border border-line bg-panel p-4">
      <p className="font-mono text-[10px] font-semibold text-muted">{label}</p>
      <p className={`mt-2 font-mono text-2xl font-semibold ${accent || 'text-white'}`}>{value}</p>
    </div>
  );
}

function DetailPanel({
  title,
  rows,
}: {
  title: string;
  rows: Array<[string, string | number | null, string?]>;
}) {
  return (
    <section data-component="DetailPanel" className="overflow-hidden rounded-xl border border-line">
      <h2 className="border-b border-line bg-panel px-5 py-3 font-mono text-xs font-semibold text-muted">
        {title}
      </h2>
      <dl className="grid gap-y-4 px-5 py-4 font-mono text-[13px] sm:grid-cols-[180px_1fr]">
        {rows.map(([label, value, color]) => (
          <div className="contents" key={label}>
            <dt className="text-cyan">{label}</dt>
            <dd className={color || 'break-all text-white'}>
              {value === null || value === '' ? '—' : value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The Info tab of a selection: the same values as for one process, one column each. */
function InfoMatrix({ processes }: { processes: IProcessDetail[] }) {
  const { progress } = useBulkAction();
  const text = (value: string | number | null) =>
    value === null || value === '' ? null : String(value);
  const row = (label: string, pick: (process: IProcessDetail) => string | number | null) => ({
    label,
    values: processes.map(process => text(pick(process))),
  });
  // Paths are compared as they are and shown shortened: two home directories
  // both shorten to "~", which would hide that they differ.
  const pathRow = (label: string, pick: (process: IProcessDetail) => string | null) => ({
    ...row(label, pick),
    cells: processes.map(process => compactPath(pick(process))),
  });

  // While a bulk action runs, the status row follows each process through it.
  const statusCells = processes.map(process => {
    const entry = progress.get(process.pmId);
    if (entry?.state === 'running') {
      return (
        <span className="flex items-center gap-1.5 text-cyan">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
          {{ start: 'starting', restart: 'restarting', stop: 'stopping' }[entry.action]}…
        </span>
      );
    }
    if (entry?.state === 'done') {
      return (
        <span className="flex items-center gap-1.5 text-online">
          <Check className="size-3.5 shrink-0" />
          {{ start: 'started', restart: 'restarted', stop: 'stopped' }[entry.action]}
        </span>
      );
    }
    if (entry?.state === 'failed') {
      return (
        <span className="flex items-center gap-1.5 text-danger" title={entry.message}>
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="truncate">{entry.message}</span>
        </span>
      );
    }
    return (
      <span className={process.status === 'online' ? 'text-online' : 'text-danger'}>
        {process.status}
      </span>
    );
  });

  return (
    <ProcessMatrix
      processes={processes}
      groups={[
        {
          title: 'EXECUTION',
          isCompared: false,
          rows: [
            { ...row('status', process => process.status), cells: statusCells },
            {
              ...row('cpu', process =>
                process.cpu === null ? null : `${process.cpu.toFixed(1)}%`
              ),
              cells: processes.map(process => (
                <span className="text-cyan">
                  {process.cpu === null ? '—' : `${process.cpu.toFixed(1)}%`}
                </span>
              )),
            },
            row('memory', process => formatBytes(process.memory)),
            row('uptime', process => formatDuration(process.uptime)),
            row('restarts', process => process.restarts),
            row('unstable restarts', process => process.unstableRestarts),
            row('pid', process => process.pid),
            row('exit code', process => process.exitCode),
            row('created', process =>
              process.createdAt ? new Date(process.createdAt).toLocaleString() : null
            ),
            row('id', process => process.pmId),
          ],
        },
        {
          title: 'CONFIGURATION',
          isCompared: true,
          rows: [
            row('namespace', process => process.namespace),
            row('version', process => process.version),
            row('mode', process => process.mode),
            row('instances', process => process.instances),
            row('node', process => process.nodeVersion),
            pathRow('interpreter', process => process.interpreter),
            pathRow('script', process => process.script),
            {
              label: 'args',
              // Compared as a list: ["a b"] and ["a", "b"] read the same once joined.
              values: processes.map(process =>
                process.args.length ? JSON.stringify(process.args) : null
              ),
              cells: processes.map(process => process.args.join(' ') || '—'),
            },
            pathRow('cwd', process => process.cwd),
            row('watch', process => (process.watching ? '✓' : '×')),
            row('cron restart', process => process.cronRestart),
          ],
        },
        {
          title: 'LOG FILES',
          // Every process writes its own files, so a difference here says nothing.
          isCompared: false,
          rows: [
            pathRow('stdout', process => process.outLogPath),
            pathRow('stderr', process => process.errLogPath),
          ],
        },
      ]}
    />
  );
}

export function InfoPage() {
  const { daemonId, pmId } = useParams({ from: '/daemons/$daemonId/processes/$pmId' });
  const details = trpc.useQueries(t =>
    parsePmIds(pmId).map(id =>
      t.processes.detail({ daemonId, pmId: id }, { refetchInterval: 2_000 })
    )
  );
  const processes = details.flatMap(detail => (detail.data ? [detail.data] : []));
  if (details.length > 1 && processes.length < details.length) {
    return <ProcessMatrixError details={details} />;
  }
  if (!processes.length) {
    return null;
  }
  if (processes.length > 1) {
    return <InfoMatrix processes={processes} />;
  }
  const process = processes[0];

  return (
    <div data-component="InfoPage" className="flex-1 overflow-auto p-4 sm:p-7">
      <div className="mx-auto max-w-[1280px] space-y-4">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Metric
            label="CPU"
            value={process.cpu === null ? '—' : `${process.cpu.toFixed(1)}%`}
            accent="text-cyan"
          />
          <Metric label="MEM" value={formatBytes(process.memory)} />
          <Metric label="UPTIME" value={formatDuration(process.uptime)} accent="text-online" />
          <Metric label="RESTARTS" value={String(process.restarts)} accent="text-warning" />
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <DetailPanel
            title="CONFIGURATION"
            rows={[
              ['id', process.pmId],
              ['namespace', process.namespace, 'text-muted'],
              ['version', process.version],
              ['script', compactPath(process.script)],
              ['args', process.args.join(' ')],
              ['cwd', compactPath(process.cwd)],
              ['mode', process.mode],
              ['interpreter', compactPath(process.interpreter), 'text-muted'],
              ['node', process.nodeVersion],
              ['instances', process.instances],
              [
                'watch',
                process.watching ? '✓' : '×',
                process.watching ? 'text-online' : 'text-danger',
              ],
              ['cron restart', process.cronRestart],
            ]}
          />
          <DetailPanel
            title="EXECUTION"
            rows={[
              [
                'status',
                process.status,
                process.status === 'online' ? 'text-online' : 'text-danger',
              ],
              ['pid', process.pid],
              ['uptime', formatDuration(process.uptime)],
              ['created', process.createdAt ? new Date(process.createdAt).toLocaleString() : null],
              ['restarts', process.restarts],
              ['unstable restarts', process.unstableRestarts],
              ['exit code', process.exitCode],
            ]}
          />
        </div>
        <DetailPanel
          title="LOG FILES"
          rows={[
            ['stdout', compactPath(process.outLogPath)],
            ['stderr', compactPath(process.errLogPath)],
          ]}
        />
      </div>
    </div>
  );
}
