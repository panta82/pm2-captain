import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeTargetNotFoundError, IFakeLocation } from '../../../../src/backend/fake/fake_daemon';
import { IFakeScenario } from '../../../../src/backend/fake/fake_scenario';
import { createFakeWorld } from '../../../../src/backend/fake/fake_world';
import type { IPM2LogEvent } from '../../../../src/backend/lib/pm2_client';

const LOCAL: IFakeLocation = { kind: 'local', pm2Home: '/srv/blue/.pm2' };
const OUT_LOG = '/srv/blue/.pm2/logs/api-out.log';

const scenario: IFakeScenario = {
  daemons: [
    {
      key: 'blue',
      processes: [{ name: 'api' }, { name: 'worker', status: 'stopped' }],
    },
    { key: 'staging', kind: 'ssh', sshArgs: ['deploy@staging'], hostname: 'staging-01' },
    { key: 'spare', pm2Home: '/srv/spare/', isRegistered: false },
  ],
};

async function setup(source: IFakeScenario = scenario) {
  const world = createFakeWorld({
    settings: { fake: { scenario: 'basic' } },
    log: { info: vi.fn() },
  } as never);
  await world.reset(source);
  const logs: IPM2LogEvent[] = [];
  const statuses: boolean[] = [];
  const handlers = {
    onLog: (event: IPM2LogEvent) => logs.push(event),
    onStatus: (connected: boolean) => statuses.push(connected),
  };
  return { world, handlers, logs, statuses };
}

describe('fakeWorld', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts Captain with the registered daemons, under IDs that never change', async () => {
    const { world } = await setup();
    const again = await setup();

    expect(world.registeredDaemons()).toEqual([
      { daemonId: expect.any(String), kind: 'local', pm2Home: '/srv/blue/.pm2' },
      { daemonId: expect.any(String), kind: 'ssh', sshArgs: ['deploy@staging'] },
    ]);
    expect(world.registeredDaemons()).toEqual(again.world.registeredDaemons());
  });

  it('leaves a first launch to detect the local daemons that are up', async () => {
    const { world } = await setup({
      isFirstLaunch: true,
      daemons: [
        { key: 'one' },
        { key: 'two', isUp: false },
        { key: 'remote', kind: 'ssh', sshArgs: ['deploy@remote'] },
      ],
    });

    expect(world.registeredDaemons()).toBeNull();
    expect(world.detectableHomes()).toEqual(['/srv/one/.pm2']);
  });

  it('fails a connection the way the real location would', async () => {
    const { world, handlers } = await setup();
    world.apply({ type: 'daemon.set', daemon: 'blue', isUp: false });
    world.apply({
      type: 'daemon.set',
      daemon: 'staging',
      isUp: false,
      error: 'ssh: connect to host staging port 22: Connection timed out',
    });

    await expect(world.connect(LOCAL, handlers)).rejects.toMatchObject({
      code: 'PM2_DAEMON_UNAVAILABLE',
      message: 'PM2 is not running in /srv/blue/.pm2.',
    });
    await expect(
      world.connect({ kind: 'local', pm2Home: '/nowhere' }, handlers)
    ).rejects.toMatchObject({ message: 'PM2 is not running in /nowhere.' });
    await expect(
      world.connect({ kind: 'ssh', sshArgs: ['deploy@staging'], pm2Home: null }, handlers)
    ).rejects.toMatchObject({
      code: 'SSH_CONNECTION_FAILED',
      message: 'ssh: connect to host staging port 22: Connection timed out',
    });
    await expect(
      world.connect({ kind: 'ssh', sshArgs: ['nobody@nowhere'], pm2Home: null }, handlers)
    ).rejects.toMatchObject({ code: 'SSH_CONNECTION_FAILED' });
  });

  it('finds a daemon by the location Captain stores for it', async () => {
    const { world, handlers } = await setup();

    // Captain strips the trailing slash from a PM2 home before it stores it.
    const spare = await world.connect({ kind: 'local', pm2Home: '/srv/spare' }, handlers);

    expect(spare.key).toBe('spare');
  });

  it('tells a connected Captain when the daemon goes away and refuses its calls', async () => {
    const { world, handlers, statuses } = await setup();
    const daemon = await world.connect(LOCAL, handlers);

    world.apply({ type: 'daemon.set', daemon: 'blue', isUp: false });
    await expect(daemon.list()).rejects.toMatchObject({ code: 'PM2_DAEMON_UNAVAILABLE' });
    world.apply({ type: 'daemon.set', daemon: 'blue', isUp: true });

    expect(statuses).toEqual([false, true]);
    expect(await daemon.list()).toHaveLength(2);
  });

  it('stops and restarts a process like PM2 does', async () => {
    const { world, handlers } = await setup();
    const daemon = await world.connect(LOCAL, handlers);
    const [before] = await daemon.describe(0);

    await daemon.stopProcess(0);
    const [stopped] = await daemon.describe(0);
    await daemon.restartProcess(0);
    const [started] = await daemon.describe(0);
    await daemon.restartProcess(0);
    const [restarted] = await daemon.describe(0);

    expect(stopped).toMatchObject({ pid: 0, pm2_env: { status: 'stopped' } });
    // Starting a stopped process is not counted as a restart.
    expect(started.pm2_env).toMatchObject({ status: 'online', restart_time: 0 });
    expect(started.pid).not.toBe(before.pid);
    expect(restarted.pm2_env).toMatchObject({ status: 'online', restart_time: 1 });
  });

  it('fails the next action once, then works again', async () => {
    const { world, handlers } = await setup();
    const daemon = await world.connect(LOCAL, handlers);
    world.apply({
      type: 'process.set',
      daemon: 'blue',
      process: 'api',
      nextActionError: 'Process failed to launch: EADDRINUSE',
    });

    await expect(daemon.restartProcess(0)).rejects.toThrow('EADDRINUSE');
    await expect(daemon.restartProcess(0)).resolves.toBeUndefined();
  });

  it('passes through a transitional status while a slow action runs', async () => {
    vi.useFakeTimers();
    const { world, handlers } = await setup();
    const daemon = await world.connect(LOCAL, handlers);
    world.apply({ type: 'process.set', daemon: 'blue', process: 'api', actionDelayMs: 2_000 });

    const stop = daemon.stopProcess(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const [during] = await daemon.describe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await stop;
    const [after] = await daemon.describe(0);

    expect(during.pm2_env?.status).toBe('stopping');
    expect(after.pm2_env?.status).toBe('stopped');
  });

  it('pages a log file backward and reports a rotation', async () => {
    const { world, handlers } = await setup();
    const daemon = await world.connect(LOCAL, handlers);
    world.apply({
      type: 'log.history',
      daemon: 'blue',
      process: 'api',
      channel: 'out',
      mode: 'replace',
      lines: ['one', 'two', 'three', 'four', 'five'],
    });

    const newest = await daemon.readLogLines(OUT_LOG, null, 2);
    const older = await daemon.readLogLines(OUT_LOG, newest.cursor, 2);
    const oldest = await daemon.readLogLines(OUT_LOG, older.cursor, 2);
    world.apply({ type: 'log.rotate', daemon: 'blue', process: 'api' });
    world.apply({
      type: 'log.emit',
      daemon: 'blue',
      process: 'api',
      channel: 'out',
      lines: ['after rotation'],
      repeat: 1,
    });
    const afterRotation = await daemon.readLogLines(OUT_LOG, newest.cursor, 2);

    expect(newest).toMatchObject({ lines: ['four', 'five'], hasMore: true, rotated: false });
    expect(older).toMatchObject({ lines: ['two', 'three'], hasMore: true });
    expect(oldest).toMatchObject({ lines: ['one'], hasMore: false, cursor: null });
    expect(afterRotation).toMatchObject({ lines: ['after rotation'], rotated: true });
  });

  it('keeps a cursor valid after old lines were dropped from a long file', async () => {
    const { world, handlers } = await setup();
    const daemon = await world.connect(LOCAL, handlers);
    world.apply({
      type: 'log.history',
      daemon: 'blue',
      process: 'api',
      channel: 'out',
      mode: 'replace',
      lines: Array.from({ length: 100_000 }, (_, index) => `line ${index}`),
    });
    const newest = await daemon.readLogLines(OUT_LOG, null, 10);

    // One more line makes the file drop its oldest tenth.
    world.apply({
      type: 'log.history',
      daemon: 'blue',
      process: 'api',
      channel: 'out',
      mode: 'append',
      lines: ['the last line'],
    });
    const older = await daemon.readLogLines(OUT_LOG, newest.cursor, 2);

    expect(newest.lines.at(-1)).toBe('line 99999');
    expect(older).toMatchObject({ lines: ['line 99988', 'line 99989'], rotated: false });
  });

  it('delivers emitted lines live and keeps them in the file', async () => {
    const { world, handlers, logs } = await setup();
    const daemon = await world.connect(LOCAL, handlers);

    world.apply({
      type: 'log.emit',
      daemon: 'blue',
      process: 'api',
      channel: 'err',
      lines: ['attempt {n} failed'],
      repeat: 2,
    });

    expect(logs.map(event => [event.type, event.packet.data, event.packet.process.pm_id])).toEqual([
      ['err', 'attempt 1 failed', 0],
      ['err', 'attempt 2 failed', 0],
    ]);
    const page = await daemon.readLogLines('/srv/blue/.pm2/logs/api-error.log', null, 10);
    expect(page.lines).toEqual(['attempt 1 failed', 'attempt 2 failed']);
  });

  it('generates logs at the set rate, only for online processes', async () => {
    vi.useFakeTimers();
    const { world, handlers, logs } = await setup();
    await world.connect(LOCAL, handlers);
    await world.start();
    world.apply({ type: 'process.set', daemon: 'blue', process: 'api', logRate: 20 });
    world.apply({ type: 'process.set', daemon: 'blue', process: 'worker', logRate: 20 });

    await vi.advanceTimersByTimeAsync(1_000);
    world.apply({ type: 'process.set', daemon: 'blue', process: 'api', logRate: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    await world.stop();

    expect(logs).toHaveLength(20);
    expect(new Set(logs.map(event => event.packet.process.name))).toEqual(new Set(['api']));
  });

  it('generates the same history for the same scenario', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T12:00:00Z') });
    const withHistory: IFakeScenario = {
      seed: 7,
      daemons: [{ key: 'blue', processes: [{ name: 'api', history: 50, logErrorRatio: 0 }] }],
    };
    const first = await setup(withHistory);
    const second = await setup(withHistory);

    const read = async (context: typeof first) =>
      (await (await context.world.connect(LOCAL, context.handlers)).readLogLines(OUT_LOG, null, 50))
        .lines;

    expect(await read(first)).toHaveLength(50);
    expect(await read(first)).toEqual(await read(second));
  });

  it('names what a command could not find', async () => {
    const { world } = await setup();

    expect(() => world.apply({ type: 'daemon.set', daemon: 'green', isUp: false })).toThrow(
      FakeTargetNotFoundError
    );
    expect(() => world.apply({ type: 'process.remove', daemon: 'blue', process: 'nope' })).toThrow(
      'The fake daemon "blue" has no process "nope".'
    );
  });
});

describe('fake scenarios', () => {
  it('loads every built-in scenario', async () => {
    for (const name of ['basic', 'busy', 'edge', 'multi', 'firehose']) {
      const { world } = await setup();
      await world.reset(name);

      expect(world.state().daemons.length, name).toBeGreaterThan(0);
    }
  });

  it('explains a scenario that is missing or wrong', async () => {
    const { world } = await setup();

    await expect(world.reset('no-such-scenario')).rejects.toMatchObject({
      code: 'FAKE_SCENARIO_NOT_FOUND',
    });
    await expect(world.reset({ daemons: [{ key: 'one', proceses: [] }] })).rejects.toMatchObject({
      code: 'FAKE_SCENARIO_INVALID',
    });
    await expect(world.reset({ daemons: [{ key: 'one' }, { key: 'one' }] })).rejects.toThrow(
      'The daemon key "one" is used twice.'
    );
    // A failed reset leaves the world as it was.
    expect(world.state().daemons.map(daemon => daemon.key)).toEqual(['blue', 'staging', 'spare']);
  });
});
