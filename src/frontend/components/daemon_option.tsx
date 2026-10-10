import { LoaderCircle, Server, ServerOff } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

import type { IDaemonStatus, IDaemonSummary, IProcessSummary } from '@shared/contracts';

import { ProcessCounts } from './process_counts';

/**
 * Column tracks for a list of DaemonOption rows. The rows are subgrids of the
 * list, so labels and process counts line up across daemons.
 */
export const DAEMON_OPTION_LIST_CLASS =
  'grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] gap-x-2.5';

/**
 * Connection state of a daemon. Deliberately not a dot: dots mean process status
 * everywhere else, including the list this sits next to.
 */
export function DaemonStatusIcon({
  status,
  className,
}: {
  status: IDaemonStatus;
  className?: string;
}) {
  const isConnecting = status === 'connecting' || status === 'reconnecting';
  const Icon = status === 'online' ? Server : isConnecting ? LoaderCircle : ServerOff;

  return (
    <Icon
      data-component="DaemonStatusIcon"
      aria-hidden
      className={cn(
        'size-3.5 shrink-0',
        status === 'online'
          ? 'text-muted'
          : isConnecting
            ? 'animate-spin text-warning'
            : 'text-danger',
        className
      )}
    />
  );
}

export function DaemonOption({
  daemon,
  processes,
  isSelected,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  daemon: IDaemonSummary;
  processes: IProcessSummary[];
  isSelected: boolean;
}) {
  const isConnecting = daemon.status === 'connecting' || daemon.status === 'reconnecting';

  return (
    <button
      type="button"
      {...props}
      data-component="DaemonOption"
      className={cn(
        'col-span-full grid grid-cols-subgrid items-center px-3 py-2 text-left font-mono text-xs text-white focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan/60',
        isSelected ? 'bg-panel-hover' : 'hover:bg-panel',
        className
      )}
    >
      <DaemonStatusIcon status={daemon.status} />
      <span className="truncate" title={daemon.label}>
        {daemon.label}
      </span>
      <span className="text-[10px] uppercase text-muted">
        {daemon.kind === 'local' ? 'local' : null}
      </span>
      {daemon.status === 'online' ? (
        <ProcessCounts
          processes={processes.filter(process => process.daemonId === daemon.daemonId)}
          className="contents"
        />
      ) : (
        <span
          className={cn(
            'col-span-2 text-right text-[10px] uppercase',
            isConnecting ? 'text-warning' : 'text-danger'
          )}
        >
          {isConnecting ? 'connecting' : 'unreachable'}
        </span>
      )}
    </button>
  );
}
