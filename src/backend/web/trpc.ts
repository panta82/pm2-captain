import { TRPCError, initTRPC } from '@trpc/server';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import type { IncomingHttpHeaders } from 'node:http';

import { AUTH_COOKIE_NAME } from '../../shared/session';
import { IContainer } from '../container';
import { defaultLog } from '../lib/logger';

export { AUTH_COOKIE_NAME };

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
    const isAuthenticated = container.sessionAuth.authenticate(req.cookies[AUTH_COOKIE_NAME]);
    // The origin the server actually listens on: a desktop backend's port is
    // assigned by the OS.
    const isOriginAllowed = isRequestOriginAllowed(
      req.headers,
      container.webServer.baseURL,
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
  errorFormatter({ shape, error, type, path, ctx }) {
    const log = ctx?.log || defaultLog;
    // Only stable identifiers: the input, error messages and stacks can quote
    // SSH arguments, which may carry secrets. Services log their own safe context.
    const causeCode = (error.cause as { code?: unknown } | undefined)?.code;
    // The typed code of a Captain error, so the UI never has to read messages.
    const appCode = typeof causeCode === 'string' ? causeCode : null;
    log.error(
      { code: error.code, appCode, errorName: error.cause?.name ?? error.name },
      `[TRPC ${type}] ${path || 'unknown'} failed`
    );
    return { ...shape, data: { ...shape.data, appCode } };
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
