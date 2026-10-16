import fastify, { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeControl } from '../../../../src/backend/fake/fake_control';
import { createFakeWorld } from '../../../../src/backend/fake/fake_world';
import { createApp } from '../../../../src/backend/lib/app';

const TOKEN = 'unit-test-token';
const headers = { authorization: `Bearer ${TOKEN}` };

let server: FastifyInstance | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function setup() {
  const log = { info: vi.fn() };
  const fakeWorld = createFakeWorld({ settings: { fake: { scenario: 'basic' } }, log } as never);
  await fakeWorld.initialize();
  const lifecycle: string[] = [];
  const daemonManager = Object.fromEntries(
    ['stop', 'dispose', 'initialize', 'start'].map(name => [
      name,
      vi.fn(async () => void lifecycle.push(name)),
    ])
  );
  const app = fastify();
  server = app;
  const control = createFakeControl({
    settings: { fake: { scenario: 'basic' } },
    fakeWorld,
    daemonManager,
    sessionAuth: { authenticate: (candidate?: string) => candidate === TOKEN },
    webServer: { register: (plugin: FastifyPluginAsync) => void app.register(plugin) },
    log,
  } as never);
  await control.initialize();
  const statusOf = (key: string, name: string) =>
    fakeWorld
      .state()
      .daemons.find(daemon => daemon.key === key)
      ?.processes.find(process => process.name === name)?.status;
  return { app, fakeWorld, lifecycle, statusOf };
}

describe('fake control routes', () => {
  it('require the launch token', async () => {
    const { app } = await setup();

    const anonymous = await app.inject({ url: '/api/fake/state' });
    const wrong = await app.inject({
      url: '/api/fake/state',
      headers: { authorization: 'Bearer nope' },
    });
    const command = await app.inject({
      method: 'POST',
      url: '/api/fake/commands',
      payload: { type: 'world.reset' },
    });
    const allowed = await app.inject({ url: '/api/fake/state', headers });

    expect([anonymous.statusCode, wrong.statusCode, command.statusCode]).toEqual([401, 401, 401]);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ scenario: 'basic', daemons: [{ key: 'local' }] });
  });

  it('reject a request that a web page made, even with the token', async () => {
    const { app, statusOf } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/api/fake/commands',
      headers: { ...headers, origin: 'http://127.0.0.1:3213' },
      payload: { type: 'process.set', daemon: 'local', process: 'api', status: 'errored' },
    });

    expect(response.statusCode).toBe(403);
    expect(statusOf('local', 'api')).toBe('online');
  });

  it('apply one command or several', async () => {
    const { app, statusOf } = await setup();

    const single = await app.inject({
      method: 'POST',
      url: '/api/fake/commands',
      headers,
      payload: { type: 'process.set', daemon: 'local', process: 'api', status: 'errored' },
    });
    const several = await app.inject({
      method: 'POST',
      url: '/api/fake/commands',
      headers,
      payload: [
        { type: 'process.set', daemon: 'local', process: 'worker', status: 'stopped' },
        { type: 'process.add', daemon: 'local', process: 'extra' },
      ],
    });

    expect(single.json()).toEqual({ applied: 1 });
    expect(several.json()).toEqual({ applied: 2 });
    expect(statusOf('local', 'api')).toBe('errored');
    expect(statusOf('local', 'worker')).toBe('stopped');
    expect(statusOf('local', 'extra')).toBe('online');
  });

  it('refuse a batch with an invalid command before applying any of it', async () => {
    const { app, statusOf } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/api/fake/commands',
      headers,
      payload: [
        { type: 'process.set', daemon: 'local', process: 'api', status: 'errored' },
        { type: 'process.set', daemon: 'local', process: 'api', staus: 'stopped' },
      ],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('staus');
    expect(statusOf('local', 'api')).toBe('online');
  });

  it('name a daemon, process or scenario that does not exist', async () => {
    const { app } = await setup();
    const send = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/fake/commands', headers, payload });

    const daemon = await send({ type: 'daemon.set', daemon: 'green', isUp: false });
    const process = await send({ type: 'process.remove', daemon: 'local', process: 'nope' });
    const scenario = await send({ type: 'world.reset', scenario: 'no-such-scenario' });

    expect([daemon.statusCode, process.statusCode, scenario.statusCode]).toEqual([404, 404, 404]);
    expect(daemon.json().error).toBe('There is no fake daemon "green".');
    expect(scenario.json().error).toContain('basic, busy, edge, multi');
  });

  it('reload Captain`s daemon list when the world is reset', async () => {
    const { app, fakeWorld, lifecycle } = await setup();
    const generation = fakeWorld.generation;

    const response = await app.inject({
      method: 'POST',
      url: '/api/fake/commands',
      headers,
      payload: { type: 'world.reset', scenario: { daemons: [{ key: 'solo' }] } },
    });

    expect(response.statusCode).toBe(200);
    expect(fakeWorld.generation).toBe(generation + 1);
    expect(fakeWorld.state().daemons.map(daemon => daemon.key)).toEqual(['solo']);
    expect(lifecycle).toEqual(['stop', 'dispose', 'initialize', 'start']);
  });

  it('lets a desktop backend be controlled through a private file, with a token for these routes only', async () => {
    const directory = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-fake-control-'));
    const controlFile = libPath.join(directory, 'fake-control.json');
    try {
      const log = { info: vi.fn() };
      const fakeWorld = createFakeWorld({
        settings: { fake: { scenario: 'basic' } },
        log,
      } as never);
      await fakeWorld.initialize();
      const app = fastify();
      server = app;
      const control = createFakeControl({
        settings: { runtime: 'desktop', fake: { scenario: 'basic', controlFile } },
        fakeWorld,
        daemonManager: {},
        sessionAuth: { authenticate: (candidate?: string) => candidate === TOKEN },
        webServer: {
          baseURL: 'http://127.0.0.1:45713',
          register: (plugin: FastifyPluginAsync) => void app.register(plugin),
        },
        log,
      } as never);
      await control.initialize();
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await control.start(async () => undefined);
      consoleLog.mockRestore();

      const written = JSON.parse(await fs.readFile(controlFile, 'utf8'));
      expect(written.baseURL).toBe('http://127.0.0.1:45713');
      expect(written.token).not.toBe(TOKEN);
      expect((await fs.stat(controlFile)).mode & 0o777).toBe(0o600);
      const allowed = await app.inject({
        url: '/api/fake/state',
        headers: { authorization: `Bearer ${written.token}` },
      });
      expect(allowed.statusCode).toBe(200);

      await control.stop();
      await expect(fs.access(controlFile)).rejects.toThrow();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('removes the control file when the app is disposed while it is still starting', async () => {
    const directory = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-fake-control-'));
    const controlFile = libPath.join(directory, 'fake-control.json');
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const log = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        isLevelEnabled: vi.fn(() => false),
      };
      // The control file is written once the web server has started, which the
      // test holds back until dispose() has been called.
      let releaseWebServer = () => undefined as void;
      const webServerStarted = new Promise<void>(resolve => {
        releaseWebServer = resolve;
      });
      const webServer = {
        baseURL: 'http://127.0.0.1:45713',
        register: () => undefined,
        start: () => webServerStarted,
      };
      const fakeControl = createFakeControl({
        settings: { runtime: 'desktop', fake: { scenario: 'basic', controlFile } },
        fakeWorld: {},
        daemonManager: {},
        sessionAuth: {},
        webServer,
        log,
      } as never);
      const app = createApp({
        container: { identifiers: ['webServer', 'fakeControl'], webServer, fakeControl },
        log,
      } as never);

      const starting = app.start();
      await vi.waitFor(() => expect(app.state.stage).toBe('ready'));
      const disposing = app.dispose();
      releaseWebServer();
      await Promise.all([starting, disposing]);

      expect(app.state.stage).toBe('idle');
      await expect(fs.access(controlFile)).rejects.toThrow();
    } finally {
      consoleLog.mockRestore();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('applies registry and update commands, with stable errors', async () => {
    const { app } = await setup();
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/fake/commands', headers, payload });

    expect((await post({ type: 'update.set', status: 'downloaded' })).statusCode).toBe(400);
    expect((await post({ type: 'registry.fail', reason: 'invalid' })).statusCode).toBe(200);
    expect((await post({ type: 'registry.remove', daemon: 'local' })).statusCode).toBe(409);
    expect((await post({ type: 'registry.recover' })).statusCode).toBe(200);
    expect(
      (await post({ type: 'update.set', status: 'downloaded', version: '9.9.9' })).statusCode
    ).toBe(200);
    const state = (await app.inject({ url: '/api/fake/state', headers })).json();
    expect(state.update).toMatchObject({ status: 'downloaded', version: '9.9.9' });
    expect(state.registry.failure).toBeNull();
  });
});
