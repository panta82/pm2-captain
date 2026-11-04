import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

import type { IProcessStatus } from '@shared/contracts';

/** A process's status as a dot: green while online, red once errored, and hollow otherwise. */
export function ProcessStatusDot({
  status,
  className,
  style,
}: {
  status: IProcessStatus;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <i
      data-component="ProcessStatusDot"
      style={style}
      className={cn(
        'size-2 shrink-0 rounded-full',
        status === 'online'
          ? 'bg-online shadow-[0_0_9px_#35D07F]'
          : status === 'errored'
            ? 'bg-danger shadow-[0_0_9px_var(--color-danger)]'
            : 'border border-muted',
        className
      )}
    />
  );
}
