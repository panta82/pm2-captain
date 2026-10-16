import { LoaderCircle, Play, RotateCw, Square } from 'lucide-react';
import { memo } from 'react';
import { toast } from 'sonner';

import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import type { IProcessDetail, IProcessSummary } from '@shared/contracts';

import { Button } from './ui';

export const ProcessActions = memo(
  function ProcessActions({
    process,
    compact = false,
    daemonAvailable = true,
  }: {
    process: IProcessSummary | IProcessDetail;
    compact?: boolean;
    daemonAvailable?: boolean;
  }) {
    const utils = trpc.useUtils();
    const action = trpc.processes.action.useMutation({
      onSuccess: async (result, variables) => {
        const completedAction = {
          start: 'started',
          restart: 'restarted',
          stop: 'stopped',
        }[variables.action];
        toast.success(`App "${process.name}" was ${completedAction}`);
        if (result.reconnecting) {
          sessionStorage.setItem('pm2-captain-reconnecting', 'true');
          window.dispatchEvent(new Event('pm2-captain-reconnecting'));
        }
        await Promise.all([
          utils.processes.list.invalidate(),
          utils.processes.detail.invalidate({ daemonId: process.daemonId, pmId: process.pmId }),
        ]);
      },
      onError: error => toast.error(error.message),
    });
    const stopped = process.status !== 'online';
    const iconClass = compact ? 'size-3.5' : 'size-4';
    const buttonClass = compact ? 'h-8 gap-1.5 px-2.5 text-xs' : '';
    const primaryButtonClass = compact
      ? 'h-8 min-w-[5.75rem] justify-start gap-1.5 px-2.5 text-xs'
      : 'min-w-[6.75rem] justify-start';
    const pendingAction = action.isPending ? action.variables?.action : undefined;
    const primaryAction = stopped ? 'start' : 'restart';
    const primaryPending = pendingAction === primaryAction;
    const stopPending = pendingAction === 'stop';

    return (
      <div
        data-component="ProcessActions"
        className="flex items-center gap-2 font-sans"
        onClick={event => event.stopPropagation()}
      >
        <Button
          variant="primary"
          className={primaryButtonClass}
          disabled={!daemonAvailable || action.isPending}
          title={!daemonAvailable ? 'Daemon is not connected' : undefined}
          onClick={() =>
            action.mutate({
              daemonId: process.daemonId,
              connectionId: process.connectionId,
              pmId: process.pmId,
              action: primaryAction,
            })
          }
        >
          {primaryPending ? (
            <LoaderCircle className={cn(iconClass, 'animate-spin')} />
          ) : stopped ? (
            <Play className={iconClass} />
          ) : (
            <RotateCw className={iconClass} />
          )}
          {stopped ? 'Start' : 'Restart'}
        </Button>
        <Button
          className={buttonClass}
          disabled={!daemonAvailable || stopped || process.isCaptain || action.isPending}
          title={
            !daemonAvailable
              ? 'Daemon is not connected'
              : stopped
                ? 'Process is already stopped'
                : process.isCaptain
                  ? 'Captain cannot stop itself'
                  : undefined
          }
          onClick={() =>
            action.mutate({
              daemonId: process.daemonId,
              connectionId: process.connectionId,
              pmId: process.pmId,
              action: 'stop',
            })
          }
        >
          {stopPending ? (
            <LoaderCircle className={cn(iconClass, 'animate-spin')} />
          ) : (
            <Square className={iconClass} />
          )}
          Stop
        </Button>
      </div>
    );
  },
  (prev, next) =>
    prev.compact === next.compact &&
    prev.daemonAvailable === next.daemonAvailable &&
    prev.process.daemonId === next.process.daemonId &&
    // A daemon moved to another location can show the same IDs and names; the
    // buttons must act on the new connection.
    prev.process.connectionId === next.process.connectionId &&
    prev.process.pmId === next.process.pmId &&
    prev.process.name === next.process.name &&
    prev.process.status === next.process.status &&
    prev.process.isCaptain === next.process.isCaptain
);
