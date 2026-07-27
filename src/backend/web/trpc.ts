import { TRPCError, initTRPC } from '@trpc/server';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import type { IncomingHttpHeaders } from 'node:http';

import { IContainer } from '../container';
import { defaultLog } from '../lib/logger';

export const AUTH_COOKIE_NAME = 'pm2_captain_session';

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value?.split(',', 1)[0]?.trim();
}

export function isRequestOriginAllowed(
  headers: IncomingHttpHeaders,
  baseURL: string,
  isAuthDisabled: boolean
) {
  const origin = headers.origin;
  if (!origin) {
    return true;
  }
  if (!isAuthDisabled) {
    return origin === baseURL;
  }

  const host = firstHeaderValue(headers['x-forwarded-host']) || headers.host;
  const protocol = firstHeaderValue(headers['x-forwarded-proto']) || 'http';
  return Boolean(host && origin === `${protocol}://${host}`);
}

export function makeCreateContext(container: IContainer) {
  return async ({ info, req, res }: CreateFastifyContextOptions) => {
    const isAuthenticated = container.captainLauncher.authenticate(req.cookies[AUTH_COOKIE_NAME]);
    const isOriginAllowed = isRequestOriginAllowed(
      req.headers,
      container.settings.baseURL,
      container.settings.noAuth
    );
    return {
      info,
      req,
      res,
      container,
      isAuthenticated,
      isOriginAllowed,
      log: container.logger.child({ transport: 'trpc' }),
    };
  };
}

export type IFastifyContext = Awaited<ReturnType<ReturnType<typeof makeCreateContext>>>;

const t = initTRPC.context<IFastifyContext>().create({
  errorFormatter({ shape, error, type, path, ctx, input }) {
    const log = ctx?.log || defaultLog;
    log.error(
      {
        input,
        error: error.cause || error,
        code: error.code,
      },
      `[TRPC ${type}] ${path || 'unknown'}: ${error.message}`
    );
    return shape;
  },
});

const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.isAuthenticated) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Open PM2 Captain through the URL printed by the CLI.',
    });
  }
  if (!ctx.isOriginAllowed) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Cross-origin requests are not allowed.',
    });
  }
  return next();
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(isAuthenticated);
