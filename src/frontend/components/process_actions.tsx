import { Play, RotateCw, Square } from 'lucide-react';
import { toast } from 'sonner';

import type { IProcessDetail, IProcessSummary } from '@shared/contracts';

import { trpc } from '@/lib/trpc';
import { Button } from './ui';

export function ProcessActions({
  process,
  compact = false,
}: {
  process: IProcessSummary | IProcessDetail;
  compact?: boolean;
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
        utils.processes.detail.invalidate({ pmId: process.pmId }),
      ]);
    },
    onError: error => toast.error(error.message),
  });
  const stopped = process.status !== 'online';
  const buttonClass = compact ? 'h-8 px-2.5 text-xs' : '';
  const pendingAction = action.isPending ? action.variables?.action : undefined;

  if (stopped) {
    return (
      <Button
        variant="primary"
        className={buttonClass}
        loading={pendingAction === 'start'}
        onClick={event => {
          event.stopPropagation();
          action.mutate({ pmId: process.pmId, action: 'start' });
        }}
      >
        {pendingAction !== 'start' ? <Play className="size-3.5" /> : null}
        Start
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2" onClick={event => event.stopPropagation()}>
      <Button
        variant="primary"
        className={buttonClass}
        loading={pendingAction === 'restart'}
        onClick={() => action.mutate({ pmId: process.pmId, action: 'restart' })}
      >
        {pendingAction !== 'restart' ? <RotateCw className="size-3.5" /> : null}
        Restart
      </Button>
      <Button
        className={buttonClass}
        disabled={process.isCaptain || action.isPending}
        loading={pendingAction === 'stop'}
        title={process.isCaptain ? 'Captain cannot stop itself' : undefined}
        onClick={() =>
          action.mutate({ pmId: process.pmId, action: 'stop' })
        }
      >
        {pendingAction !== 'stop' ? <Square className="size-3" /> : null}
        Stop
      </Button>
    </div>
  );
}
