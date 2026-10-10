import cookie from '@fastify/cookie';
import middie from '@fastify/middie';
import fastifyStatic from '@fastify/static';
import { FastifyTRPCPluginOptions, fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import fastify, { LogController } from 'fastify';
import { Socket } from 'node:net';
import libPath from 'node:path';

import { PACKAGE_VERSION, ROOT_DIR } from '../backend_settings';
import { InvalidDaemonError } from '../bl/daemon_manager';
import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { createLoggerOptions } from '../lib/logger';
import { IAppRouter, createAppRouter, daemonInputSchema } from './app_router';
import { AUTH_COOKIE_NAME, makeCreateContext } from './trpc';

export function isBackendRequestPath(path: string) {
  return (
    path === '/health' ||
    path === '/launch' ||
    path.startsWith('/launch/') ||
    path.startsWith('/api/')
  );
}

export function createWebServer({ log, container }: IContainer) {
  const app = fastify({
    logger: { ...createLoggerOptions(container.settings.debug), level: 'warn' },
    logController: new LogController({
      disableRequestLogging: !container.settings.debug,
    }),
    forceCloseConnections: true,
  });
  let viteServer: Awaited<ReturnType<(typeof import('vite'))['createServer']>> | null = null;

  app.register(cookie);

  app.get('/health', async () => ({
    name: 'pm2-captain',
    version: PACKAGE_VERSION,
    pid: process.pid,
  }));

  app.get('/launch', async (request, reply) => {
    if (container.settings.noAuth) {
      return reply.redirect('/');
    }
    const token = (request.query as { token?: string }).token;
    if (!container.captainLauncher.authenticate(token)) {
      return reply.status(401).type('text/plain').send('Invalid PM2 Captain launch token.');
    }
    reply.setCookie(AUTH_COOKIE_NAME, token!, {
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      path: '/',
    });
    return reply.redirect('/');
  });

  app.post('/launch/daemon', async (request, reply) => {
    if (request.headers.origin) {
      return reply
        .status(403)
        .send({ error: 'Browser-originated launch handoffs are not allowed.' });
    }

    const authorization = request.headers.authorization;
    const candidate = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!container.captainLauncher.authenticate(candidate)) {
      return reply.status(401).send({ error: 'Invalid PM2 Captain launch token.' });
    }

    const input = daemonInputSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: 'Invalid daemon.' });
    }

    try {
      return await container.daemonManager.add(input.data);
    } catch (error) {
      if (error instanceof InvalidDaemonError) {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.register(fastifyTRPCPlugin, {
    prefix: '/api/trpc',
    trpcOptions: {
      router: createAppRouter(container),
      createContext: makeCreateContext(container),
    } satisfies FastifyTRPCPluginOptions<IAppRouter>['trpcOptions'],
  });

  const socketMap = new Map<Socket, boolean>();
  app.server.on('connection', socket => {
    socketMap.set(socket, true);
    socket.on('close', () => socketMap.delete(socket));
  });

  return {
    start: async () => {
      if (container.settings.serverDevMode) {
        await app.register(middie);
        const vite = await import('vite');
        viteServer = await vite.createServer({
          configFile: libPath.join(ROOT_DIR, 'vite.config.mjs'),
          server: {
            middlewareMode: true,
            hmr: { server: app.server },
          },
          appType: 'spa',
        });
        app.use((request, response, next) => {
          const path = request.url?.split('?', 1)[0] || '';
          if (isBackendRequestPath(path)) {
            next();
            return;
          }
          viteServer!.middlewares(request, response, next);
        });
      } else {
        await app.register(fastifyStatic, {
          root: libPath.join(ROOT_DIR, 'dist/frontend'),
          wildcard: false,
        });
        app.get('/*', async (request, reply) => {
          if (
            request.headers.accept?.includes('text/html') &&
            !container.captainLauncher.authenticate(request.cookies[AUTH_COOKIE_NAME])
          ) {
            return reply
              .status(401)
              .type('text/html')
              .send(
                '<!doctype html><title>PM2 Captain</title><body style="font-family:system-ui;background:#071A2B;color:white;padding:3rem"><h1>PM2 Captain is locked</h1><p>Run <code>pm2-captain</code> and use the printed URL.</p></body>'
              );
          }
          return reply.sendFile('index.html');
        });
      }

      const address = await app.listen({
        host: container.settings.host,
        port: container.settings.port,
        listenTextResolver: () => '',
      });
      log.info(`PM2 Captain is listening at ${address}`);
    },
    stop: async () => {
      await viteServer?.close();
      if (socketMap.size) {
        await Promise.all(
          Array.from(socketMap.keys()).map(
            socket => new Promise<void>(resolve => socket.end(resolve))
          )
        );
      }
      await app.close();
      log.info('Server closed');
    },
  };
}

export default define({
  createWebServer,
});
