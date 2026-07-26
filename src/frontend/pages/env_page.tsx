import { useParams } from '@tanstack/react-router';

import { trpc } from '@/lib/trpc';

import { Skeleton } from '@/components/ui';

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
      <section className="mx-auto max-w-[1280px] overflow-hidden rounded-xl border border-line bg-topbar">
        <h2 className="border-b border-line bg-panel px-5 py-3 font-mono text-xs font-semibold text-muted">
          ENVIRONMENT
        </h2>
        {environment.length ? (
          <dl className="divide-y divide-line/70 font-mono text-[13px]">
            {environment.map(variable => (
              <div
                className="grid gap-1 px-5 py-3 sm:grid-cols-[minmax(180px,0.4fr)_minmax(0,1fr)] sm:gap-6"
                key={variable.name}
              >
                <dt className="break-all text-cyan">{variable.name}</dt>
                <dd className="break-all text-white">
                  {variable.value || <span className="text-muted">(empty)</span>}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="px-5 py-10 text-center font-mono text-sm text-muted">
            No environment variables found.
          </p>
        )}
      </section>
    </div>
  );
}
