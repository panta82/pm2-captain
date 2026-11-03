import { LoaderCircle, RotateCw } from 'lucide-react';
import { toast } from 'sonner';

import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import type { IDaemonStatus } from '@shared/contracts';

import { Button } from './ui';

export const isDaemonConnecting = (status: IDaemonStatus) =>
  status === 'connecting' || status === 'reconnecting';

/** Retries a failed daemon connection without waiting for the scheduled attempt. */
export function DaemonRetryButton({
  daemonId,
  isPrimary = false,
  className,
}: {
  daemonId: string;
  isPrimary?: boolean;
  className?: string;
}) {
  const utils = trpc.useUtils();
  const retry = trpc.daemons.retry.useMutation({
    onSuccess: () => utils.processes.list.invalidate(),
    onError: error => toast.error(error.message),
  });

  return (
    <Button
      data-component="DaemonRetryButton"
      variant={isPrimary ? 'primary' : 'secondary'}
      disabled={retry.isPending}
      className={cn(!isPrimary && 'h-8 gap-1.5 px-2.5 text-xs', className)}
      onClick={event => {
        // The rest of the daemon's row selects it.
        event.stopPropagation();
        retry.mutate({ daemonId });
      }}
    >
      {retry.isPending ? (
        <LoaderCircle className={cn('animate-spin', isPrimary ? 'size-4' : 'size-3.5')} />
      ) : (
        <RotateCw className={isPrimary ? 'size-4' : 'size-3.5'} />
      )}
      Try again
    </Button>
  );
}
