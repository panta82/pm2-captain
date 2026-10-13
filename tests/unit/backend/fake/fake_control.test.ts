import fastify, { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeControl } from '../../../../src/backend/fake/fake_control';
import { createFakeWorld } from '../../../../src/backend/fake/fake_world';

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
    captainLauncher: { authenticate: (candidate?: string) => candidate === TOKEN },
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
});
