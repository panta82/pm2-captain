import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ProcessActions } from '@/components/process_actions';
import { ProcessSidebar } from '@/components/process_sidebar';
import { Button, Skeleton } from '@/components/ui';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

export function ProcessLayout() {
  const { pmId } = useParams({ from: '/processes/$pmId' });
  const numericId = Number(pmId);
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const list = trpc.processes.list.useQuery(undefined, { refetchInterval: 2_000 });
  const detail = trpc.processes.detail.useQuery(
    { pmId: numericId },
    {
      refetchInterval: query => (query.state.error ? false : 2_000),
      retry: (failureCount, error) =>
        error.data?.code !== 'NOT_FOUND' && failureCount < 2,
    }
  );

  useEffect(() => {
    if (detail.error?.data?.code === 'NOT_FOUND') {
      void navigate({ to: '/', replace: true });
    }
  }, [detail.error, navigate]);

  if (detail.isLoading || list.isLoading) {
    return <Skeleton className="m-6 h-72" />;
  }
  if (!detail.data || !list.data) {
    return (
      <div className="grid flex-1 place-items-center text-danger">
        {detail.error?.message || 'Process not found'}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <ProcessSidebar processes={list.data.processes} selectedId={numericId} />
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
              <Button variant="ghost" className="size-9 p-0" onClick={() => setMobileMenuOpen(false)}>
                <X className="size-4" />
              </Button>
            </div>
            {list.data.processes.map(process => (
              <Link
                key={process.pmId}
                to="/processes/$pmId/info"
                params={{ pmId: String(process.pmId) }}
                onClick={() => setMobileMenuOpen(false)}
                className={cn(
                  'mb-1 flex h-11 items-center gap-3 rounded-lg px-3 text-sm',
                  process.pmId === numericId ? 'bg-panel-hover text-white' : 'text-muted'
                )}
              >
                <i className={cn('size-2 rounded-full', process.status === 'online' ? 'bg-online' : 'border border-muted')} />
                <span className="truncate">{process.name}</span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <section className="shrink-0 border-b border-line bg-panel/45 px-4 pt-4 sm:px-7 sm:pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <Button
                variant="ghost"
                className="size-9 shrink-0 p-0 lg:hidden"
                onClick={() => setMobileMenuOpen(true)}
              >
                <Menu className="size-4" />
              </Button>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-xl font-bold text-white sm:text-2xl">
                    {detail.data.name}
                  </h1>
                  <span className="font-mono text-xs text-muted">id {detail.data.pmId}</span>
                  <span
                    className={cn(
                      'rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider',
                      detail.data.status === 'online'
                        ? 'border-online/50 bg-online/10 text-online'
                        : 'border-muted/40 text-muted'
                    )}
                  >
                    {detail.data.status}
                  </span>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-muted sm:text-sm">
                  {detail.data.args.join(' ') || detail.data.script || 'PM2 process'} · {detail.data.mode}
                  {detail.data.nodeVersion ? ` · ${detail.data.nodeVersion}` : ''}
                </p>
              </div>
            </div>
            <div className="hidden items-center gap-2 sm:flex">
              <ProcessActions process={detail.data} />
              <Button
                variant="ghost"
                className="size-10 p-0"
                aria-label="Close process"
                onClick={() => navigate({ to: '/' })}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>
          <div className="mt-4 flex items-end justify-between">
            <nav className="flex gap-3">
              <Link
                to="/processes/$pmId/info"
                params={{ pmId }}
                activeProps={{ className: 'border-cyan text-cyan' }}
                inactiveProps={{ className: 'border-transparent text-muted hover:text-white' }}
                className="border-b-2 px-3 pb-3 text-sm font-semibold transition-colors"
              >
                Info
              </Link>
              <Link
                to="/processes/$pmId/logs"
                params={{ pmId }}
                activeProps={{ className: 'border-cyan text-cyan' }}
                inactiveProps={{ className: 'border-transparent text-muted hover:text-white' }}
                className="border-b-2 px-3 pb-3 text-sm font-semibold transition-colors"
              >
                Logs
              </Link>
            </nav>
            <div className="pb-2 sm:hidden">
              <ProcessActions process={detail.data} compact />
            </div>
          </div>
        </section>
        <Outlet />
      </main>
    </div>
  );
}
