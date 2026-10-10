import libOs from 'node:os';
import libPath from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DaemonConflictError,
  InvalidDaemonError,
  createDaemonManager,
} from '../../../../src/backend/bl/daemon_manager';
import type { IDaemonConfig } from '../../../../src/shared/contracts';

interface IFakeSettings {
  runtimeDaemonId: string;
  pm2Home: string | null;
  sshArgs: string[] | null;
}

interface IFakeContainer {
  settings: IFakeSettings;
  app: {
    dispose: ReturnType<typeof vi.fn>;
  };
  pm2Client: {
    onDaemonStatus: ReturnType<typeof vi.fn>;
  };
  processManager: {
    list: ReturnType<typeof vi.fn>;
  };
}

const mocked = vi.hoisted(() => ({
  containers: [] as IFakeContainer[],
  unavailableDaemonIds: new Set<string>(),
  createDaemonContainer: vi.fn((settings: IFakeSettings) => {
    const state = { stage: 'idle' };
    const remoteInfo = settings.sshArgs ? { hostname: 'remote', username: 'deploy' } : null;
    const container = {
      settings,
      app: {
        state,
        start: vi.fn(async () => {
          if (mocked.unavailableDaemonIds.has(settings.runtimeDaemonId)) {
            throw new Error(`PM2 is not running in ${settings.pm2Home}.`);
          }
          state.stage = 'active';
          return true;
        }),
        stop: vi.fn(async () => {
          state.stage = 'ready';
          return true;
        }),
        dispose: vi.fn(async () => {
          state.stage = 'idle';
          return true;
        }),
      },
      sshConnection: { remoteInfo },
      pm2Client: { onDaemonStatus: vi.fn(() => vi.fn()) },
      processManager: {
        list: vi.fn(async () => ({
          hostname: remoteInfo?.hostname || 'laptop',
          username: remoteInfo?.username || 'captain',
          processes: [
            {
              daemonId: settings.runtimeDaemonId,
              pmId: 0,
              name: `process-${settings.runtimeDaemonId}`,
            },
          ],
        })),
      },
      logManager: {},
    };
    mocked.containers.push(container as IFakeContainer);
    return container;
  }),
}));

vi.mock('../../../../src/backend/container', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../src/backend/container')>()),
  createDaemonContainer: mocked.createDaemonContainer,
}));

const DEFAULT_HOME = libPath.join(libOs.homedir(), '.pm2');

const storedDaemons: IDaemonConfig[] = [
  {
    daemonId: '6f0b8a52-5f6c-4c41-9f0f-2a3b7f6f1d10',
    kind: 'local',
    pm2Home: '/srv/pm2-blue',
  },
  {
    daemonId: '830f902f-c88b-4ed8-8051-c3a81c44ed87',
    kind: 'ssh',
    sshArgs: ['deploy@one.example.com'],
    lastKnownHostname: 'remote',
    lastKnownUsername: 'deploy',
  },
  {
    daemonId: 'b61e3d2f-b6d1-4af2-8e2f-6bb3fdf1f7fa',
    kind: 'ssh',
    sshArgs: ['-p', '2222', 'deploy@two.example.com'],
    pm2Home: '/opt/pm2',
    lastKnownHostname: 'remote',
    lastKnownUsername: 'deploy',
  },
];

function setup({
  daemons = storedDaemons,
  detectedHomes = [],
  pm2Home = null,
  sshArgs = null,
}: {
  daemons?: IDaemonConfig[] | null;
  detectedHomes?: string[];
  pm2Home?: string | null;
  sshArgs?: string[] | null;
} = {}) {
  const daemonStore = {
    load: vi.fn().mockResolvedValue(daemons),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const pm2HomeFinder = { find: vi.fn().mockResolvedValue(detectedHomes) };
  const manager = createDaemonManager({
    settings: { pm2Home, sshArgs, runtimeDaemonId: null },
    daemonStore,
    pm2HomeFinder,
    log: { info: vi.fn(), warn: vi.fn() },
  } as never);
  return { manager, daemonStore, pm2HomeFinder };
}

async function startManager(options: Parameters<typeof setup>[0] = {}) {
  const context = setup(options);
  await context.manager.initialize();
  await context.manager.start();
  await vi.waitFor(() =>
    expect(context.manager.listDaemons().some(daemon => daemon.status === 'connecting')).toBe(false)
  );
  return context;
}

describe('daemonManager', () => {
  beforeEach(() => {
    mocked.containers.length = 0;
    mocked.unavailableDaemonIds.clear();
    mocked.createDaemonContainer.mockClear();
  });

  it('fills a list that was never set up with the detected local PM2 homes', async () => {
    const { manager, daemonStore } = await startManager({
      daemons: null,
      detectedHomes: [DEFAULT_HOME, '/srv/pm2-green'],
    });
    await manager.listProcesses();

    const saved = daemonStore.save.mock.calls[0][0] as IDaemonConfig[];
    expect(saved.map(({ kind, pm2Home }) => [kind, pm2Home])).toEqual([
      ['local', DEFAULT_HOME],
      ['local', '/srv/pm2-green'],
    ]);
    // A PM2 home other than the default is part of the name.
    expect(manager.listDaemons().map(daemon => daemon.label)).toEqual([
      'captain@laptop',
      'captain@laptop:/srv/pm2-green',
    ]);
  });

  it('remembers an empty detection and does not detect again', async () => {
    const first = setup({ daemons: null });
    await first.manager.initialize();
    expect(first.daemonStore.save).toHaveBeenCalledWith([]);

    const { manager, daemonStore, pm2HomeFinder } = setup({ daemons: [] });
    await manager.initialize();

    expect(pm2HomeFinder.find).not.toHaveBeenCalled();
    expect(daemonStore.save).not.toHaveBeenCalled();
    expect(manager.listDaemons()).toEqual([]);
  });

  it('adds a local or remote PM2 home named on the command line once', async () => {
    const local = setup({ daemons: [], pm2Home: '/srv/pm2-green' });
    await local.manager.initialize();
    expect(local.daemonStore.save.mock.calls[0][0]).toMatchObject([
      { kind: 'local', pm2Home: '/srv/pm2-green' },
    ]);

    const remote = setup({ daemons: [], sshArgs: ['tk-dev'], pm2Home: '~/.pm2-staging/' });
    await remote.manager.initialize();
    expect(remote.daemonStore.save.mock.calls[0][0]).toMatchObject([
      { kind: 'ssh', sshArgs: ['tk-dev'], pm2Home: '~/.pm2-staging' },
    ]);

    const existing = setup({
      sshArgs: ['-p', '2222', 'deploy@two.example.com'],
      pm2Home: '/opt/pm2',
    });
    await existing.manager.initialize();
    expect(existing.daemonStore.save).not.toHaveBeenCalled();
  });

  it('keeps duplicate PM2 ids distinct and passes each daemon its PM2 home', async () => {
    const { manager } = await startManager();

    const result = await manager.listProcesses();

    expect(result.processes.map(process => [process.daemonId, process.pmId])).toEqual(
      storedDaemons.map(daemon => [daemon.daemonId, 0])
    );
    expect(
      mocked.containers.map(container => [container.settings.pm2Home, container.settings.sshArgs])
    ).toEqual([
      ['/srv/pm2-blue', null],
      [null, ['deploy@one.example.com']],
      ['/opt/pm2', ['-p', '2222', 'deploy@two.example.com']],
    ]);
    expect(result.daemons.map(daemon => daemon.label)).toEqual([
      'captain@laptop:/srv/pm2-blue',
      'deploy@remote',
      'deploy@remote:/opt/pm2',
    ]);
  });

  it('keeps other daemons usable when a PM2 is not running', async () => {
    mocked.unavailableDaemonIds.add(storedDaemons[0].daemonId);
    const { manager } = await startManager();

    const result = await manager.listProcesses();

    expect(result.daemons.map(daemon => [daemon.status, daemon.error])).toEqual([
      ['error', 'PM2 is not running in /srv/pm2-blue.'],
      ['online', null],
      ['online', null],
    ]);
    expect(result.processes.map(process => process.daemonId)).toEqual([
      storedDaemons[1].daemonId,
      storedDaemons[2].daemonId,
    ]);
  });

  it('keeps the last known processes while a daemon reconnects', async () => {
    const { manager } = await startManager();
    await manager.listProcesses();
    const [first] = mocked.containers;
    const reportDaemonStatus = first.pm2Client.onDaemonStatus.mock.calls[0][0];

    reportDaemonStatus(false);
    const result = await manager.listProcesses();

    expect(result.daemons[0]).toMatchObject({ status: 'reconnecting' });
    expect(result.processes.map(process => process.daemonId)).toContain(storedDaemons[0].daemonId);
    expect(first.processManager.list).toHaveBeenCalledOnce();
  });

  it('treats each PM2 location as its own daemon', async () => {
    const { manager, daemonStore } = await startManager();

    const sameLocal = await manager.add({ kind: 'local', pm2Home: '/srv/pm2-blue/' });
    const sameRemote = await manager.add({
      kind: 'ssh',
      sshArgs: ['-p', '2222', 'deploy@two.example.com'],
      pm2Home: '/opt/pm2',
    });
    const otherRemoteHome = await manager.add({
      kind: 'ssh',
      sshArgs: ['deploy@one.example.com'],
      pm2Home: '/opt/pm2',
    });
    const otherLocalHome = await manager.add({ kind: 'local', pm2Home: '/srv/pm2-green' });

    expect([sameLocal.added, sameRemote.added]).toEqual([false, false]);
    expect([otherRemoteHome.added, otherLocalHome.added]).toEqual([true, true]);
    // The new SSH daemon may already have saved the identity it reported.
    expect(daemonStore.save.mock.lastCall?.[0]).toMatchObject([
      ...storedDaemons,
      {
        daemonId: otherRemoteHome.daemon.daemonId,
        kind: 'ssh',
        sshArgs: ['deploy@one.example.com'],
        pm2Home: '/opt/pm2',
      },
      { daemonId: otherLocalHome.daemon.daemonId, kind: 'local', pm2Home: '/srv/pm2-green' },
    ]);
  });

  it('rejects a remote PM2 home that the server cannot resolve or forward', async () => {
    const { manager, daemonStore } = await startManager();

    for (const pm2Home of ['relative/pm2', '/srv/pm2:blue', '~deploy/.pm2']) {
      await expect(
        manager.add({ kind: 'ssh', sshArgs: ['tk-dev'], pm2Home })
      ).rejects.toBeInstanceOf(InvalidDaemonError);
    }
    expect(daemonStore.save).not.toHaveBeenCalled();
  });

  it('renames a daemon without reconnecting it', async () => {
    const { manager, daemonStore } = await startManager();

    const updated = await manager.update(storedDaemons[1].daemonId, {
      kind: 'ssh',
      sshArgs: ['deploy@one.example.com'],
      label: 'staging',
    });

    expect(updated).toMatchObject({ label: 'staging', status: 'online' });
    expect(daemonStore.save).toHaveBeenCalledWith([
      storedDaemons[0],
      { ...storedDaemons[1], label: 'staging' },
      storedDaemons[2],
    ]);
    expect(mocked.containers).toHaveLength(3);
    expect(mocked.containers[1].app.dispose).not.toHaveBeenCalled();
  });

  it('reconnects a daemon in place when its PM2 location changes', async () => {
    const { manager, daemonStore } = await startManager();

    const remote = await manager.update(storedDaemons[1].daemonId, {
      kind: 'ssh',
      sshArgs: ['deploy@one.example.com'],
      pm2Home: '~/.pm2-staging',
    });
    const local = await manager.update(storedDaemons[0].daemonId, {
      kind: 'local',
      pm2Home: '/srv/pm2-green',
    });

    // The identity remembered for the old location is dropped until the new one reports in.
    expect(remote.config).toEqual({
      daemonId: storedDaemons[1].daemonId,
      kind: 'ssh',
      sshArgs: ['deploy@one.example.com'],
      pm2Home: '~/.pm2-staging',
    });
    expect(local.config).toEqual({
      daemonId: storedDaemons[0].daemonId,
      kind: 'local',
      pm2Home: '/srv/pm2-green',
    });
    expect(daemonStore.save.mock.lastCall?.[0]).toMatchObject([
      local.config,
      remote.config,
      storedDaemons[2],
    ]);
    await vi.waitFor(() => expect(mocked.containers[1].app.dispose).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mocked.containers[0].app.dispose).toHaveBeenCalledOnce());
    expect(mocked.containers.slice(3).map(container => container.settings.pm2Home)).toEqual([
      '~/.pm2-staging',
      '/srv/pm2-green',
    ]);
    await vi.waitFor(() =>
      expect(manager.listDaemons().map(daemon => [daemon.daemonId, daemon.status])).toEqual(
        storedDaemons.map(daemon => [daemon.daemonId, 'online'])
      )
    );
  });

  it('rejects an edit that duplicates another daemon or switches its kind', async () => {
    const { manager, daemonStore } = await startManager();

    await expect(
      manager.update(storedDaemons[1].daemonId, {
        kind: 'ssh',
        sshArgs: ['-p', '2222', 'deploy@two.example.com'],
        pm2Home: '/opt/pm2',
      })
    ).rejects.toBeInstanceOf(DaemonConflictError);
    await expect(
      manager.update(storedDaemons[0].daemonId, { kind: 'ssh', sshArgs: ['tk-dev'] })
    ).rejects.toBeInstanceOf(InvalidDaemonError);

    expect(daemonStore.save).not.toHaveBeenCalled();
    expect(mocked.containers).toHaveLength(3);
  });

  it('removes any daemon and persists the removal before disposing it', async () => {
    const { manager, daemonStore } = await startManager();

    await manager.remove(storedDaemons[0].daemonId);

    expect(daemonStore.save).toHaveBeenCalledWith(storedDaemons.slice(1));
    expect(mocked.containers[0].app.dispose).toHaveBeenCalledOnce();
    expect(manager.listDaemons().map(daemon => daemon.daemonId)).toEqual(
      storedDaemons.slice(1).map(daemon => daemon.daemonId)
    );
  });
});
