import { memo } from 'react';

import { useDaemonConnectionId } from '@/lib/daemon_connection';
import { processRouteApi } from '@/lib/process_route';
import { trpc } from '@/lib/trpc';

import { ProcessMatrix, ProcessMatrixError } from '@/components/process_matrix';
import { Skeleton } from '@/components/ui';

import type { IEnvironmentVariable } from '@shared/contracts';

const EnvPanel = memo(function EnvPanel({ environment }: { environment: IEnvironmentVariable[] }) {
  return (
    <section data-component="EnvPanel" className="overflow-hidden rounded-xl border border-line">
      <h2 className="flex items-center gap-2 border-b border-line bg-panel px-5 py-3 font-mono text-xs font-semibold text-muted">
        <span>ENVIRONMENT</span>
        <span className="ml-auto font-normal text-muted">{environment.length}</span>
      </h2>
      <dl className="divide-y divide-line/70 font-mono text-[13px]">
        {environment.map(variable => (
          <div
            // Keep every value searchable/copyable without laying out offscreen
            // rows each time this retained tab is shown. Measured heights survive
            // later visits; the estimate applies only before a row is rendered.
            className="grid gap-1 px-5 py-3 [contain-intrinsic-block-size:auto_44px] [content-visibility:auto] sm:grid-cols-[minmax(180px,0.4fr)_minmax(0,1fr)] sm:gap-6"
            key={variable.name}
          >
            <dt
              className={variable.isDivergent ? 'break-all text-warning/80' : 'break-all text-cyan'}
              title={variable.isDivergent ? 'Differs from local environment' : undefined}
            >
              {variable.name}
            </dt>
            <dd className="break-all text-white">
              {variable.value || <span className="text-muted">(empty)</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
});

export function EnvPage() {
  // Selecting only these keeps a tab change from re-rendering this tab.
  const { daemonId, pmIds } = processRouteApi.useParams({
    select: ({ daemonId, pmIds }) => ({ daemonId, pmIds }),
    structuralSharing: true,
  });
  const connectionId = useDaemonConnectionId(daemonId);
  const details = trpc.useQueries(t =>
    pmIds.map(id =>
      t.processes.detail(
        { daemonId, connectionId, pmId: id, includeEnvironment: true },
        { staleTime: 30_000, refetchInterval: 30_000, enabled: connectionId !== undefined }
      )
    )
  );
  const processes = details.flatMap(detail => (detail.data ? [detail.data] : []));

  if (details.length > 1 && processes.length < details.length) {
    return <ProcessMatrixError details={details} />;
  }
  if (!processes.length) {
    return (
      <div data-component="EnvPage" className="flex-1 overflow-auto p-4 sm:p-7">
        <Skeleton className="mx-auto h-72 max-w-[1280px]" />
      </div>
    );
  }

  // A selection shows one column per process, and one row per variable any of them has.
  if (processes.length > 1) {
    const environments = processes.map(
      process =>
        new Map((process.environment ?? []).map(variable => [variable.name, variable.value]))
    );
    const names = [...new Set(environments.flatMap(environment => [...environment.keys()]))];
    return (
      <ProcessMatrix
        processes={processes}
        groups={[
          {
            title: 'ENVIRONMENT',
            isCompared: true,
            rows: names.sort().map(name => ({
              label: name,
              values: environments.map(environment => environment.get(name) ?? null),
            })),
          },
        ]}
      />
    );
  }

  const environment = processes[0].environment ?? [];

  return (
    <div
      data-component="EnvPage"
      // PROCESS_PANE_ATTRIBUTE: Enter in the process list comes here.
      data-process-pane
      tabIndex={-1}
      className="flex-1 overflow-auto p-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan/70 sm:p-7"
    >
      <div className="mx-auto max-w-[1280px] space-y-4">
        {environment.length ? (
          <EnvPanel environment={environment} />
        ) : (
          <section className="overflow-hidden rounded-xl border border-line">
            <h2 className="border-b border-line bg-panel px-5 py-3 font-mono text-xs font-semibold text-muted">
              ENVIRONMENT
            </h2>
            <p className="px-5 py-10 text-center font-mono text-sm text-muted">
              No environment variables found.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
