import { useEffect, useRef } from 'react';

import { trpc } from '@/lib/trpc';

/**
 * The daemon's current connection, from the shared process list. Reads carry
 * it, so a daemon that was moved to another location starts over with fresh
 * caches, cursors and streams instead of showing the old location's data.
 */
export function useDaemonConnectionId(daemonId: string): string | undefined {
  // Selecting the ID alone re-renders only when it changes, not on every poll.
  const connection = trpc.processes.list.useQuery(undefined, {
    refetchInterval: 2_000,
    select: data => data.daemons.find(daemon => daemon.daemonId === daemonId)?.connectionId,
  });
  return connection.data;
}

/**
 * Calls `onReplaced` when the same daemon's connection changes from one known
 * ID to another, which happens when its location changes. The first load and
 * label edits do not count.
 */
export function useConnectionReplaced(
  daemonId: string,
  connectionId: string | undefined,
  onReplaced: () => void
) {
  const seenRef = useRef<{ daemonId: string; connectionId: string } | null>(null);
  const onReplacedRef = useRef(onReplaced);
  onReplacedRef.current = onReplaced;

  useEffect(() => {
    if (connectionId === undefined) {
      return;
    }
    const previous = seenRef.current;
    seenRef.current = { daemonId, connectionId };
    if (previous?.daemonId === daemonId && previous.connectionId !== connectionId) {
      onReplacedRef.current();
    }
  }, [daemonId, connectionId]);
}
