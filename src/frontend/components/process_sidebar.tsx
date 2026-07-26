import { Link } from '@tanstack/react-router';

import type { ProcessSummary } from '@shared/contracts';

import { cn } from '@/lib/utils';

export function ProcessSidebar({
  processes,
  selectedId,
}: {
  processes: ProcessSummary[];
  selectedId: number;
}) {
  return (
    <aside className="hidden w-[244px] shrink-0 border-r border-line bg-topbar py-3 lg:block">
      <nav aria-label="Processes">
        {processes.map(process => (
          <Link
            key={process.pmId}
            to="/processes/$pmId/info"
            params={{ pmId: String(process.pmId) }}
            className={cn(
              'relative mx-2 flex h-12 items-center gap-3 rounded-lg px-3 text-sm transition-colors',
              process.pmId === selectedId
                ? 'border border-primary/50 bg-panel-hover text-white'
                : 'text-white/90 hover:bg-panel'
            )}
          >
            {process.pmId === selectedId ? (
              <i className="absolute -left-[9px] h-7 w-1 rounded-r bg-primary" />
            ) : null}
            <i
              className={cn(
                'size-2 shrink-0 rounded-full',
                process.status === 'online'
                  ? 'bg-online shadow-[0_0_9px_#35D07F]'
                  : 'border border-muted'
              )}
            />
            <span className="min-w-0 flex-1 truncate font-semibold">{process.name}</span>
            {process.isCaptain ? (
              <span className="rounded border border-cyan/60 px-1 py-0.5 font-mono text-[9px] text-cyan">
                YOU
              </span>
            ) : null}
            <span className="font-mono text-[11px] text-muted">
              {process.cpu === null ? '—' : `${process.cpu.toFixed(1)}%`}
            </span>
          </Link>
        ))}
      </nav>
    </aside>
  );
}
