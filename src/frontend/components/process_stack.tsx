import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

import type { IProcessStatus, IProcessSummary } from '@shared/contracts';

import { ProcessStatusDot } from './process_status_dot';

/** Past this many processes, the dots stand for shares of them instead. */
const MAX_DOTS = 6;

/** What a dot can show, in the stack's order. Any other status shows as stopped. */
const KINDS = [
  { status: 'online', label: 'online' },
  { status: 'errored', label: 'errored' },
  { status: 'stopped', label: 'offline' },
] as const satisfies ReadonlyArray<{ status: IProcessStatus; label: string }>;

/**
 * Cuts the next dot, and a gap around it, out of a dot it overlaps. The dots are
 * 8px and 6px apart, so the next one's center is 10px from this one's left edge.
 * A cut instead of a ring in the background's color works on any background.
 */
const OVERLAPPED_STYLE: CSSProperties = {
  mask: 'radial-gradient(circle at 10px 50%, transparent 5.5px, #000 6px)',
};

/**
 * A group of processes as a small stack of the same status dots the processes
 * have, quieter than theirs. Hovering it gives the numbers.
 */
export function ProcessStack({
  processes,
  className,
}: {
  processes: IProcessSummary[];
  className?: string;
}) {
  const total = processes.length;
  const kinds = KINDS.map(kind => ({
    ...kind,
    count: processes.filter(process =>
      kind.status === 'stopped'
        ? process.status !== 'online' && process.status !== 'errored'
        : process.status === kind.status
    ).length,
  })).filter(kind => kind.count);

  // With more processes than dots, every kind there is keeps a dot, and the rest
  // go to the kinds that fall shortest of their share.
  const dotCounts = kinds.map(kind => (total <= MAX_DOTS ? kind.count : 1));
  for (let left = Math.min(total, MAX_DOTS) - kinds.length; total > MAX_DOTS && left > 0; left--) {
    const shortfalls = kinds.map(
      (kind, index) => (kind.count / total) * MAX_DOTS - dotCounts[index]
    );
    dotCounts[shortfalls.indexOf(Math.max(...shortfalls))] += 1;
  }
  const dots = kinds.flatMap((kind, index) =>
    Array.from({ length: dotCounts[index] }, () => kind.status)
  );
  const summary = total
    ? kinds.map(kind => `${kind.count} ${kind.label}`).join(', ')
    : 'No processes';

  return (
    <span
      data-component="ProcessStack"
      role="img"
      aria-label={summary}
      title={summary}
      className={cn('flex shrink-0 items-center opacity-70', className)}
    >
      {dots.map((status, index) => (
        <ProcessStatusDot
          key={index}
          status={status}
          className={cn('shadow-none', index > 0 && '-ml-0.5')}
          style={index < dots.length - 1 ? OVERLAPPED_STYLE : undefined}
        />
      ))}
    </span>
  );
}
