import { LoaderCircle, Play, RotateCw, Square } from 'lucide-react';
import { memo } from 'react';
import { toast } from 'sonner';

import { useShortcutAria } from '@/lib/keyboard_shortcuts';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import type { IProcessDetail, IProcessSummary } from '@shared/contracts';

import { ShortcutHint } from './shortcut_hint';
import { Button } from './ui';

export const ProcessActions = memo(
  function ProcessActions({
    process,
    compact = false,
    daemonAvailable = true,
    hasShortcut = false,
  }: {
    process: IProcessSummary | IProcessDetail;
    compact?: boolean;
    daemonAvailable?: boolean;
    /** The process page's buttons, which the restart shortcut presses; not each row's. */
    hasShortcut?: boolean;
  }) {
    const utils = trpc.useUtils();
    const restartShortcut = useShortcutAria('process.restart');
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
          className={cn(primaryButtonClass, hasShortcut && 'relative')}
          disabled={!daemonAvailable || action.isPending}
          title={!daemonAvailable ? 'Daemon is not connected' : undefined}
          // The shortcut presses this button, so it starts a stopped process.
          data-shortcut={hasShortcut ? 'process.restart' : undefined}
          aria-keyshortcuts={hasShortcut ? restartShortcut : undefined}
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
          {hasShortcut ? (
            <ShortcutHint action="process.restart" className="-top-2.5 -right-2" />
          ) : null}
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
    prev.hasShortcut === next.hasShortcut &&
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
