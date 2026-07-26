import { useParams } from '@tanstack/react-router';

import { trpc } from '@/lib/trpc';

import { Skeleton } from '@/components/ui';

import type { IEnvironmentVariable } from '@shared/contracts';

function EnvPanel({ environment }: { environment: IEnvironmentVariable[] }) {
  return (
    <section
      data-component="EnvPanel"
      className="overflow-hidden rounded-xl border border-line bg-topbar"
    >
      <h2 className="flex items-center gap-2 border-b border-line bg-panel px-5 py-3 font-mono text-xs font-semibold text-muted">
        <span>ENVIRONMENT</span>
        <span className="ml-auto font-normal text-muted">{environment.length}</span>
      </h2>
      <dl className="divide-y divide-line/70 font-mono text-[13px]">
        {environment.map(variable => (
          <div
            className="grid gap-1 px-5 py-3 sm:grid-cols-[minmax(180px,0.4fr)_minmax(0,1fr)] sm:gap-6"
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
}

export function EnvPage() {
  const { pmId } = useParams({ from: '/processes/$pmId' });
  const detail = trpc.processes.detail.useQuery({
    pmId: Number(pmId),
    includeEnvironment: true,
  });

  if (!detail.data) {
    return (
      <div data-component="EnvPage" className="flex-1 overflow-auto p-4 sm:p-7">
        <Skeleton className="mx-auto h-72 max-w-[1280px]" />
      </div>
    );
  }

  const environment = detail.data.environment ?? [];

  return (
    <div data-component="EnvPage" className="flex-1 overflow-auto p-4 sm:p-7">
      <div className="mx-auto max-w-[1280px] space-y-4">
        {environment.length ? (
          <EnvPanel environment={environment} />
        ) : (
          <section className="overflow-hidden rounded-xl border border-line bg-topbar">
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
