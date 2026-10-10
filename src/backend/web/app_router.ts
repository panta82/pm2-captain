import { TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { z } from 'zod';

import { ILogStreamEvent } from '@shared/contracts';

import {
  DaemonConflictError,
  DaemonNotFoundError,
  DaemonUnavailableError,
  InvalidDaemonError,
} from '../bl/daemon_manager';
import { ProcessNotFoundError } from '../bl/process_manager';
import { IContainer } from '../container';
import { protectedProcedure, router } from './trpc';

const processActionSchema = z.enum(['start', 'stop', 'restart']);
const logViewSchema = z.enum(['combined', 'out', 'err']);
const daemonIdSchema = z.string().uuid();

/** A daemon as entered by a user or passed on Captain's command line. */
export const daemonInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    pm2Home: z.string().trim().min(1),
    label: z.string().trim().min(1).optional(),
  }),
  z.object({
    kind: z.literal('ssh'),
    sshArgs: z.array(z.string()).min(1),
    pm2Home: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional(),
  }),
]);

async function withProcessErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProcessNotFoundError || error instanceof DaemonNotFoundError) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: error.message,
        cause: error,
      });
    }
    if (error instanceof DaemonUnavailableError) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: error.message,
        cause: error,
      });
    }
    if (error instanceof InvalidDaemonError) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: error.message,
        cause: error,
      });
    }
    if (error instanceof DaemonConflictError) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: error.message,
        cause: error,
      });
    }
    throw error;
  }
}

export function createAppRouter(container: IContainer) {
  return router({
    session: router({
      /**
       * Held open by every tab that has no log stream, so the launcher knows
       * whether a tab is around to reconnect after a restart. It never emits.
       */
      presence: protectedProcedure.subscription(() =>
        observable<never>(() => container.captainLauncher.trackTab())
      ),
    }),
    daemons: router({
      list: protectedProcedure.query(() => container.daemonManager.listSettings()),
      add: protectedProcedure
        .input(daemonInputSchema)
        .mutation(({ input }) => withProcessErrors(() => container.daemonManager.add(input))),
      update: protectedProcedure
        .input(z.object({ daemonId: daemonIdSchema, daemon: daemonInputSchema }))
        .mutation(({ input }) =>
          withProcessErrors(() => container.daemonManager.update(input.daemonId, input.daemon))
        ),
      remove: protectedProcedure
        .input(z.object({ daemonId: daemonIdSchema }))
        .mutation(({ input }) =>
          withProcessErrors(() => container.daemonManager.remove(input.daemonId))
        ),
      retry: protectedProcedure
        .input(z.object({ daemonId: daemonIdSchema }))
        .mutation(({ input }) =>
          withProcessErrors(() => container.daemonManager.retry(input.daemonId))
        ),
    }),
    processes: router({
      list: protectedProcedure.query(() => container.daemonManager.listProcesses()),
      detail: protectedProcedure
        .input(
          z.object({
            daemonId: daemonIdSchema,
            pmId: z.number().int().nonnegative(),
            includeEnvironment: z.boolean().optional(),
          })
        )
        .query(({ input }) =>
          withProcessErrors(() =>
            container.daemonManager.detail(input.daemonId, input.pmId, input.includeEnvironment)
          )
        ),
      action: protectedProcedure
        .input(
          z.object({
            daemonId: daemonIdSchema,
            pmId: z.number().int().nonnegative(),
            action: processActionSchema,
          })
        )
        .mutation(({ input }) =>
          withProcessErrors(() =>
            container.daemonManager.action(input.daemonId, input.pmId, input.action)
          )
        ),
    }),
    logs: router({
      page: protectedProcedure
        .input(
          z.object({
            daemonId: daemonIdSchema,
            pmId: z.number().int().nonnegative(),
            view: logViewSchema,
            cursor: z.string().nullable().optional(),
            limit: z.number().int().min(1).max(1_000).default(500),
          })
        )
        .query(({ input }) =>
          withProcessErrors(() =>
            container.daemonManager.logPage(
              input.daemonId,
              input.pmId,
              input.view,
              input.cursor,
              input.limit
            )
          )
        ),
      stream: protectedProcedure
        .input(
          z.object({
            daemonId: daemonIdSchema,
            pmId: z.number().int().nonnegative(),
            view: logViewSchema,
          })
        )
        .subscription(({ input }) => {
          const stream = container.daemonManager.logStream(input.daemonId, input.pmId, input.view);
          // Browsers allow few connections per origin, so a tab on the logs
          // page reports its presence through this stream instead of a second one.
          return observable<ILogStreamEvent>(emit => {
            const releaseTab = container.captainLauncher.trackTab();
            const subscription = stream.subscribe(emit);
            return () => {
              subscription.unsubscribe();
              releaseTab();
            };
          });
        }),
    }),
  });
}

export type IAppRouter = ReturnType<typeof createAppRouter>;
