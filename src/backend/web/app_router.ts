import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { IContainer } from '../container';
import { ProcessNotFoundError } from '../bl/process_manager';
import { protectedProcedure, router } from './trpc';

const processActionSchema = z.enum(['start', 'stop', 'restart']);
const logViewSchema = z.enum(['combined', 'out', 'err']);

async function withProcessErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProcessNotFoundError) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: error.message,
        cause: error,
      });
    }
    throw error;
  }
}

export function createAppRouter(container: IContainer) {
  return router({
    processes: router({
      list: protectedProcedure.query(() => container.processManager.list()),
      detail: protectedProcedure
        .input(z.object({ pmId: z.number().int().nonnegative() }))
        .query(({ input }) =>
          withProcessErrors(() => container.processManager.detail(input.pmId))
        ),
      action: protectedProcedure
        .input(
          z.object({
            pmId: z.number().int().nonnegative(),
            action: processActionSchema,
          })
        )
        .mutation(({ input }) =>
          withProcessErrors(() =>
            container.processManager.action(input.pmId, input.action)
          )
        ),
    }),
    logs: router({
      page: protectedProcedure
        .input(
          z.object({
            pmId: z.number().int().nonnegative(),
            view: logViewSchema,
            cursor: z.string().nullable().optional(),
            limit: z.number().int().min(1).max(1_000).default(500),
          })
        )
        .query(({ input }) =>
          withProcessErrors(() =>
            container.logManager.page(
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
            pmId: z.number().int().nonnegative(),
            view: logViewSchema,
          })
        )
        .subscription(({ input }) => container.logManager.stream(input.pmId, input.view)),
    }),
  });
}

export type IAppRouter = ReturnType<typeof createAppRouter>;
