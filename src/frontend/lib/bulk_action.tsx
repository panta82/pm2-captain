import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import { bulkActionTargets } from '@/lib/process_selection';
import { trpc } from '@/lib/trpc';

import type { IProcessAction, IProcessSummary } from '@shared/contracts';

/** How long a finished process keeps showing "restarted" before its status returns. */
const DONE_DISPLAY_MS = 3_000;

export interface IBulkActionProgress {
  action: IProcessAction;
  state: 'running' | 'done' | 'failed';
  /** Why the action failed. */
  message?: string;
}

export interface IBulkAction {
  /** Per PM2 ID: what the last bulk action did, or is doing, to that process. */
  progress: ReadonlyMap<number, IBulkActionProgress>;
  runningAction: IProcessAction | null;
  run: (action: IProcessAction, processes: IProcessSummary[]) => void;
}

const BulkActionContext = createContext<IBulkAction>({
  progress: new Map(),
  runningAction: null,
  run: () => undefined,
});

export function useBulkAction(): IBulkAction {
  return useContext(BulkActionContext);
}

const COMPLETED_ACTION: Record<IProcessAction, string> = {
  start: 'started',
  restart: 'restarted',
  stop: 'stopped',
};

/** Runs one action on a selection of processes of one daemon and tracks each of them. */
export function BulkActionProvider({
  daemonId,
  children,
}: {
  daemonId: string;
  children: ReactNode;
}) {
  const utils = trpc.useUtils();
  const [progress, setProgress] = useState<ReadonlyMap<number, IBulkActionProgress>>(new Map());
  const [runningAction, setRunningAction] = useState<IProcessAction | null>(null);
  const clearTimerRef = useRef<number | undefined>(undefined);
  // Counts runs and daemon switches. A run that is no longer the current one still
  // finishes its requests, but may not touch the state any more.
  const generationRef = useRef(0);

  // PM2 IDs repeat across daemons, so nothing of a run carries over to another one.
  useEffect(() => {
    setProgress(new Map());
    setRunningAction(null);
    return () => {
      generationRef.current++;
      window.clearTimeout(clearTimerRef.current);
    };
  }, [daemonId]);

  const run = useCallback(
    async (action: IProcessAction, processes: IProcessSummary[]) => {
      const targets = bulkActionTargets(action, processes);
      if (!targets.length) {
        return;
      }
      window.clearTimeout(clearTimerRef.current);
      const generation = ++generationRef.current;
      const isCurrent = () => generationRef.current === generation;
      setRunningAction(action);
      setProgress(new Map(targets.map(process => [process.pmId, { action, state: 'running' }])));

      let isReconnecting = false;
      let lastError = '';
      const act = async (process: IProcessSummary) => {
        try {
          const result = await utils.client.processes.action.mutate({
            daemonId: process.daemonId,
            pmId: process.pmId,
            action,
          });
          isReconnecting ||= result.reconnecting;
          if (isCurrent()) {
            setProgress(current => new Map(current).set(process.pmId, { action, state: 'done' }));
          }
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'The action failed.';
          lastError = message;
          if (isCurrent()) {
            setProgress(current =>
              new Map(current).set(process.pmId, { action, state: 'failed', message })
            );
          }
          return false;
        }
      };
      // Captain goes last: its own restart drops this browser's connection.
      const results = await Promise.all(targets.filter(process => !process.isCaptain).map(act));
      for (const captain of targets.filter(process => process.isCaptain)) {
        results.push(await act(captain));
      }

      const doneCount = results.filter(Boolean).length;
      if (targets.length === 1) {
        if (doneCount) {
          toast.success(`App "${targets[0].name}" was ${COMPLETED_ACTION[action]}`);
        } else {
          toast.error(lastError);
        }
      } else if (doneCount === targets.length) {
        toast.success(`${doneCount} processes were ${COMPLETED_ACTION[action]}`);
      } else {
        toast.error(
          `${doneCount} of ${targets.length} processes were ${COMPLETED_ACTION[action]}, ${targets.length - doneCount} failed`
        );
      }
      if (isReconnecting) {
        sessionStorage.setItem('pm2-captain-reconnecting', 'true');
        window.dispatchEvent(new Event('pm2-captain-reconnecting'));
      }
      await Promise.all([utils.processes.list.invalidate(), utils.processes.detail.invalidate()]);
      if (!isCurrent()) {
        return;
      }
      setRunningAction(null);
      // Failures stay until the next action, so the reason can still be read.
      clearTimerRef.current = window.setTimeout(() => {
        setProgress(
          current => new Map([...current].filter(([, entry]) => entry.state === 'failed'))
        );
      }, DONE_DISPLAY_MS);
    },
    [utils]
  );

  const value = useMemo(() => ({ progress, runningAction, run }), [progress, runningAction, run]);

  return <BulkActionContext.Provider value={value}>{children}</BulkActionContext.Provider>;
}
