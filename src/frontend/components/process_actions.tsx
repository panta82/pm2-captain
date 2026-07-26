import { Play, RotateCw, Square } from 'lucide-react';
import { toast } from 'sonner';

import type { ProcessDetail, ProcessSummary } from '@shared/contracts';

import { trpc } from '@/lib/trpc';
import { Button, ConfirmAction } from './ui';

export function ProcessActions({
  process,
  compact = false,
}: {
  process: ProcessSummary | ProcessDetail;
  compact?: boolean;
}) {
  const utils = trpc.useUtils();
  const action = trpc.processes.action.useMutation({
    onSuccess: async result => {
      toast.success(result.reconnecting ? 'Captain is restarting…' : 'PM2 action completed');
      if (result.reconnecting) {
        sessionStorage.setItem('pm2-captain-reconnecting', 'true');
        window.dispatchEvent(new Event('pm2-captain-reconnecting'));
      }
      await Promise.all([
        utils.processes.list.invalidate(),
        utils.processes.detail.invalidate({ pmId: process.pmId }),
      ]);
    },
    onError: error => toast.error(error.message),
  });
  const stopped = process.status !== 'online';
  const buttonClass = compact ? 'h-8 px-2.5 text-xs' : '';

  if (stopped) {
    return (
      <Button
        variant="primary"
        className={buttonClass}
        loading={action.isPending}
        onClick={event => {
          event.stopPropagation();
          action.mutate({ pmId: process.pmId, action: 'start' });
        }}
      >
        <Play className="size-3.5" />
        Start
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2" onClick={event => event.stopPropagation()}>
      <Button
        variant="primary"
        className={buttonClass}
        loading={action.isPending && action.variables?.action === 'restart'}
        onClick={() => action.mutate({ pmId: process.pmId, action: 'restart' })}
      >
        <RotateCw className="size-3.5" />
        Restart
      </Button>
      <ConfirmAction
        title={`Stop ${process.name}?`}
        description={
          process.isCaptain
            ? 'Captain protects its own control process from being stopped.'
            : 'PM2 will stop this process but keep it in the process list so it can be started again.'
        }
        confirmLabel="Stop process"
        onConfirm={() => action.mutate({ pmId: process.pmId, action: 'stop' })}
        trigger={
          <Button
            className={buttonClass}
            disabled={process.isCaptain || action.isPending}
            title={process.isCaptain ? 'Captain cannot stop itself' : undefined}
          >
            <Square className="size-3" />
            Stop
          </Button>
        }
      />
    </div>
  );
}
