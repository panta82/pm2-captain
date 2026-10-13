import { describe, expect, it, vi } from 'vitest';

import { createLogManager } from '../../../../src/backend/bl/log_manager';
import { createProcessManager } from '../../../../src/backend/bl/process_manager';
import { createPm2Daemon } from '../../../../src/backend/fake/fake_pm2_daemon';
import { IFakeScenario } from '../../../../src/backend/fake/fake_scenario';
import { createFakeWorld } from '../../../../src/backend/fake/fake_world';
import type { IAppLifecycleMethods } from '../../../../src/backend/lib/app';
import type { IPm2Daemon } from '../../../../src/backend/lib/pm2_daemon';
import type { ILogStreamEvent } from '../../../../src/shared/contracts';

const DAEMON_ID = 'daemon-1';

const scenario: IFakeScenario = {
  daemons: [
    {
      key: 'blue',
      processes: [
        { name: 'api', cpu: 12.5, memory: 2048, restarts: 3, env: { API_KEY: 'shown-on-request' } },
        { name: 'pm2-captain', pid: 'captain' },
        {
          name: 'shared',
          outLogPath: '/srv/blue/.pm2/logs/shared.log',
          errLogPath: '/srv/blue/.pm2/logs/shared.log',
        },
      ],
    },
    {
      key: 'staging',
      kind: 'ssh',
      sshArgs: ['deploy@staging'],
      hostname: 'staging-01',
      processes: [{ name: 'remote-captain', pid: 'captain' }],
    },
  ],
};

/** Wires the fake daemon under the real business rules, the way a daemon container does. */
async function setup(settings: { sshArgs: string[] | null; pm2Home: string | null }) {
  const log = { info: vi.fn(), error: vi.fn() };
  const fakeWorld = createFakeWorld({ settings: { fake: { scenario: 'basic' } }, log } as never);
  await fakeWorld.reset(scenario);
  const daemonSettings = { ...settings, runtimeDaemonId: DAEMON_ID };
  // The daemon container's app is what normally connects and disconnects it.
  const pm2Daemon = createPm2Daemon({
    settings: daemonSettings,
    fakeWorld,
  } as never) as IPm2Daemon & IAppLifecycleMethods;
  const processManager = createProcessManager({
    pm2Daemon,
    log,
    settings: daemonSettings,
  } as never);
  const logManager = createLogManager({
    pm2Daemon,
    processManager,
    settings: daemonSettings,
  } as never);
  return { fakeWorld, pm2Daemon, processManager, logManager };
}

const local = () => setup({ sshArgs: null, pm2Home: '/srv/blue/.pm2' });

describe('fake pm2Daemon', () => {
  it('produces processes that the process manager reads like real PM2 output', async () => {
    const { pm2Daemon, processManager } = await local();
    await pm2Daemon.start!(vi.fn());

    const list = await processManager.list();
    const detail = await processManager.detail(0, true);

    expect(list).toMatchObject({ hostname: 'fake-host', username: 'captain' });
    expect(list.processes[0]).toMatchObject({
      daemonId: DAEMON_ID,
      pmId: 0,
      name: 'api',
      namespace: 'default',
      status: 'online',
      mode: 'fork',
      cpu: 12.5,
      memory: 2048,
      restarts: 3,
      version: '1.0.0',
      isCaptain: false,
    });
    expect(list.processes[0].uptime).toBeGreaterThan(0);
    expect(detail).toMatchObject({
      script: '/srv/apps/api/dist/index.js',
      outLogPath: '/srv/blue/.pm2/logs/api-out.log',
      errLogPath: '/srv/blue/.pm2/logs/api-error.log',
    });
    expect(detail.environment).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'API_KEY', value: 'shown-on-request' }),
      ])
    );
    expect(JSON.stringify(list)).not.toContain('shown-on-request');
  });

  it('makes a local process Captain itself, with the usual protection', async () => {
    const { pm2Daemon, processManager } = await local();
    await pm2Daemon.start!(vi.fn());

    expect((await processManager.detail(1)).isCaptain).toBe(true);
    await expect(processManager.action(1, 'stop')).rejects.toThrow('cannot stop itself');
  });

  it('is a remote daemon when its location is an SSH destination', async () => {
    const { pm2Daemon, processManager } = await setup({
      sshArgs: ['deploy@staging'],
      pm2Home: null,
    });

    // Like a real server, nothing is known about it before it answers.
    expect(pm2Daemon.identity).toBeNull();
    await pm2Daemon.start!(vi.fn());

    expect(pm2Daemon.isLocal).toBe(false);
    expect(await processManager.list()).toMatchObject({ hostLabel: 'deploy@staging-01' });
    expect((await processManager.detail(0)).isCaptain).toBe(false);
  });

  it('refuses PM2 calls until it is connected', async () => {
    const { pm2Daemon, processManager } = await local();

    await expect(processManager.list()).rejects.toMatchObject({ code: 'PM2_DAEMON_UNAVAILABLE' });
    await pm2Daemon.start!(vi.fn());
    await pm2Daemon.stop!(vi.fn());
    await expect(processManager.list()).rejects.toMatchObject({ code: 'PM2_DAEMON_UNAVAILABLE' });
  });

  it('feeds history and live lines through the log manager', async () => {
    const { fakeWorld, pm2Daemon, logManager } = await local();
    await pm2Daemon.start!(vi.fn());
    fakeWorld.apply({
      type: 'log.history',
      daemon: 'blue',
      process: 'api',
      channel: 'out',
      mode: 'replace',
      lines: ['2026-01-01T10:00:00.000Z first', '2026-01-01T10:00:02.000Z third'],
    });
    fakeWorld.apply({
      type: 'log.history',
      daemon: 'blue',
      process: 'api',
      channel: 'err',
      mode: 'replace',
      lines: ['2026-01-01T10:00:01.000Z second'],
    });
    const events: ILogStreamEvent[] = [];
    const subscription = logManager.stream(0, 'combined').subscribe({
      next: event => events.push(event),
    });

    const page = await logManager.page(0, 'combined', null, 10);
    fakeWorld.apply({
      type: 'log.emit',
      daemon: 'blue',
      process: 'api',
      channel: 'err',
      lines: ['live line'],
      repeat: 1,
    });
    fakeWorld.apply({ type: 'daemon.set', daemon: 'blue', isUp: false });
    subscription.unsubscribe();

    expect(page.entries.map(entry => [entry.channel, entry.text])).toEqual([
      ['out', '2026-01-01T10:00:00.000Z first'],
      ['err', '2026-01-01T10:00:01.000Z second'],
      ['out', '2026-01-01T10:00:02.000Z third'],
    ]);
    expect(page).toMatchObject({ approximateOrder: false, sharedFile: false, hasMore: false });
    expect(events).toMatchObject([
      { type: 'log', entry: { channel: 'err', text: 'live line', processName: 'api' } },
      { type: 'daemon-status', connected: false },
    ]);
  });

  it('shares one log file between stdout and stderr when the paths match', async () => {
    const { fakeWorld, pm2Daemon, logManager } = await local();
    await pm2Daemon.start!(vi.fn());
    fakeWorld.apply({
      type: 'log.emit',
      daemon: 'blue',
      process: 'shared',
      channel: 'out',
      lines: ['to stdout'],
      repeat: 1,
    });
    fakeWorld.apply({
      type: 'log.emit',
      daemon: 'blue',
      process: 'shared',
      channel: 'err',
      lines: ['to stderr'],
      repeat: 1,
    });

    const page = await logManager.page(2, 'combined', null, 10);

    expect(page.sharedFile).toBe(true);
    expect(page.entries.map(entry => entry.text)).toEqual(['to stdout', 'to stderr']);
  });
});
