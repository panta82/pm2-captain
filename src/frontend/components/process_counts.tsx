import { cn } from '@/lib/utils';

import type { IProcessSummary } from '@shared/contracts';

export function ProcessCounts({
  processes,
  className,
}: {
  processes: IProcessSummary[];
  className?: string;
}) {
  const online = processes.filter(process => process.status === 'online').length;
  const offline = processes.length - online;

  return (
    <span
      data-component="ProcessCounts"
      className={cn('flex items-center gap-3 font-mono text-xs tabular-nums text-muted', className)}
    >
      <span className="flex items-center gap-2" title={`${online} online`}>
        <i className="size-2 rounded-full bg-online shadow-[0_0_10px_#35D07F]" />
        {online}
      </span>
      <span className="flex items-center gap-2" title={`${offline} offline`}>
        <i className="size-2 rounded-full border border-muted" />
        {offline}
      </span>
    </span>
  );
}
