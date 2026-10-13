import { LoaderCircle, type LucideIcon, Play, RotateCw, Square } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useBulkAction } from '@/lib/bulk_action';
import { bulkActionTargets } from '@/lib/process_selection';
import { cn } from '@/lib/utils';

import type { IProcessAction, IProcessSummary } from '@shared/contracts';

import { Button } from './ui';

/** How long the Stop button waits for its confirming second click. */
const STOP_CONFIRM_MS = 3_000;

/** Start, Restart and Stop for a selection. Each button counts the processes it will act on. */
export function BulkProcessActions({
  processes,
  compact = false,
  daemonAvailable = true,
}: {
  processes: IProcessSummary[];
  compact?: boolean;
  daemonAvailable?: boolean;
}) {
  const bulkAction = useBulkAction();
  const startCount = bulkActionTargets('start', processes).length;
  const restartCount = bulkActionTargets('restart', processes).length;
  const stopTargets = bulkActionTargets('stop', processes);
  const stopCount = stopTargets.length;
  // The confirmation is for exactly the processes it was asked for. A changed
  // selection, or a process that stopped meanwhile, takes a new first click.
  const stopKey = stopTargets.map(process => `${process.daemonId}:${process.pmId}`).join(',');
  const [armedStopKey, setArmedStopKey] = useState<string | null>(null);
  const isStopArmed = armedStopKey === stopKey;

  useEffect(() => {
    if (armedStopKey === null) {
      return;
    }
    // Going back to the same processes later does not bring the confirmation back.
    if (armedStopKey !== stopKey) {
      setArmedStopKey(null);
      return;
    }
    const timer = window.setTimeout(() => setArmedStopKey(null), STOP_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [armedStopKey, stopKey]);

  const isCaptainSkipped = restartCount > stopCount;
  const iconClass = compact ? 'size-3.5' : 'size-4';
  const sizeClass = cn('whitespace-nowrap', compact && 'h-8 gap-1.5 px-2.5 text-xs');

  const actionButton = (
    action: IProcessAction,
    label: string,
    Icon: LucideIcon,
    count: number,
    variant: 'primary' | 'secondary',
    title?: string
  ) => (
    <Button
      variant={variant}
      className={sizeClass}
      disabled={!daemonAvailable || !count || bulkAction.runningAction !== null}
      title={!daemonAvailable ? 'Daemon is not connected' : title}
      onClick={() => bulkAction.run(action, processes)}
    >
      {bulkAction.runningAction === action ? (
        <LoaderCircle className={cn(iconClass, 'animate-spin')} />
      ) : (
        <Icon className={iconClass} />
      )}
      {label}
      {count ? <span className="font-mono font-medium tabular-nums">{count}</span> : null}
    </Button>
  );

  return (
    <div data-component="BulkProcessActions" className="flex items-center gap-2 font-sans">
      {actionButton('start', 'Start', Play, startCount, restartCount ? 'secondary' : 'primary')}
      {actionButton('restart', 'Restart', RotateCw, restartCount, 'primary')}
      {isStopArmed && stopCount > 1 && bulkAction.runningAction === null ? (
        <Button
          variant="danger"
          className={sizeClass}
          disabled={!daemonAvailable}
          onClick={() => {
            setArmedStopKey(null);
            bulkAction.run('stop', processes);
          }}
        >
          <Square className={iconClass} />
          Really stop {stopCount}?
        </Button>
      ) : stopCount > 1 ? (
        // Stopping several processes at once takes a second click.
        <Button
          className={sizeClass}
          disabled={!daemonAvailable || bulkAction.runningAction !== null}
          title={
            !daemonAvailable
              ? 'Daemon is not connected'
              : isCaptainSkipped
                ? 'Captain is skipped: it cannot stop itself'
                : undefined
          }
          onClick={() => setArmedStopKey(stopKey)}
        >
          <Square className={iconClass} />
          Stop
          <span className="font-mono font-medium tabular-nums">{stopCount}</span>
        </Button>
      ) : (
        actionButton(
          'stop',
          'Stop',
          Square,
          stopCount,
          'secondary',
          isCaptainSkipped ? 'Captain is skipped: it cannot stop itself' : undefined
        )
      )}
    </div>
  );
}
