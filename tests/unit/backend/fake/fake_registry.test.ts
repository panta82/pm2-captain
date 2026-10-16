import { describe, expect, it, vi } from 'vitest';

import {
  FakeRegistryUnavailableError,
  InvalidFakeCommandError,
} from '../../../../src/backend/fake/fake_commands';
import { FakeTargetNotFoundError } from '../../../../src/backend/fake/fake_daemon';
import { createDaemonStore } from '../../../../src/backend/fake/fake_daemon_store';
import { IFakeScenario } from '../../../../src/backend/fake/fake_scenario';
import { createFakeWorld } from '../../../../src/backend/fake/fake_world';
import { DaemonRegistryError } from '../../../../src/backend/lib/daemon_store';

const scenario: IFakeScenario = {
  daemons: [
    { key: 'blue', pm2Home: '/srv/blue/.pm2' },
    { key: 'staging', kind: 'ssh', sshArgs: ['deploy@staging'] },
    { key: 'spare', pm2Home: '/srv/spare', isRegistered: false },
  ],
};

async function setup() {
  const world = createFakeWorld({
    settings: { fake: { scenario: 'basic' } },
    log: { info: vi.fn() },
  } as never);
  await world.reset(scenario);
  const store = createDaemonStore({ fakeWorld: world } as never);
  const onHint = vi.fn();
  const stopWatching = await store.watch(onHint);
  return { world, store, onHint, stopWatching };
}

describe('fake daemon registry', () => {
  it('starts with the scenario’s registered daemons, read through the store', async () => {
    const { world, store } = await setup();

    const daemons = await store.load();

    expect(daemons?.map(config => config.daemonId)).toEqual(
      world
        .state()
        .daemons.filter(daemon => daemon.isRegistered)
        .map(daemon => daemon.daemonId)
    );
  });

  it('applies external edits and tells the watcher, as a changed file would', async () => {
    const { world, store, onHint } = await setup();
    const blueId = world.state().daemons[0].daemonId;

    world.apply({ type: 'registry.edit', daemon: 'blue', label: 'Blue' });
    world.apply({ type: 'registry.edit', daemon: 'blue', pm2Home: '/srv/blue2/.pm2' });
    world.apply({ type: 'registry.remove', daemon: 'staging' });
    world.apply({ type: 'registry.add', daemon: 'spare' });

    expect(onHint).toHaveBeenCalledTimes(4);
    expect(await store.load()).toEqual([
      { daemonId: blueId, kind: 'local', pm2Home: '/srv/blue2/.pm2', label: 'Blue' },
      expect.objectContaining({ kind: 'local', pm2Home: '/srv/spare' }),
    ]);
    world.apply({ type: 'registry.edit', daemon: 'blue', label: null });
    expect((await store.load())?.[0]).not.toHaveProperty('label');
  });

  it('fails like the real store while broken, and recovers the same list', async () => {
    const { world, store } = await setup();
    const before = await store.load();

    world.apply({ type: 'registry.fail', reason: 'invalid' });
    await expect(store.load()).rejects.toThrow(DaemonRegistryError);
    await expect(store.mutate(current => current ?? [])).rejects.toThrow(/not valid JSON/);
    world.apply({ type: 'registry.fail', reason: 'unreadable' });
    await expect(store.load()).rejects.toThrow(/cannot be read/);
    world.apply({ type: 'registry.fail', reason: 'missing' });
    await expect(store.load()).resolves.toBeNull();
    expect(() => world.apply({ type: 'registry.remove', daemon: 'blue' })).toThrow(
      FakeRegistryUnavailableError
    );

    world.apply({ type: 'registry.recover' });
    await expect(store.load()).resolves.toEqual(before);
  });

  it('keeps Captain’s own saves, and reports them to the watcher', async () => {
    const { world, store, onHint } = await setup();

    await store.mutate(current => current!.slice(0, 1));

    expect(world.registry.daemons).toHaveLength(1);
    expect(onHint).toHaveBeenCalledOnce();
  });

  it('rejects edits it cannot make', async () => {
    const { world } = await setup();

    expect(() => world.apply({ type: 'registry.edit', daemon: 'blue' })).toThrow(
      InvalidFakeCommandError
    );
    expect(() => world.apply({ type: 'registry.edit', daemon: 'spare', label: 'x' })).toThrow(
      FakeTargetNotFoundError
    );
    expect(() => world.apply({ type: 'registry.remove', daemon: 'nope' })).toThrow(
      FakeTargetNotFoundError
    );
  });

  it('starts the registry and the simulated update over on reset, and stops watching cleanly', async () => {
    const { world, store, onHint, stopWatching } = await setup();
    world.apply({ type: 'registry.fail', reason: 'invalid' });
    world.apply({ type: 'update.set', status: 'downloaded', version: '9.9.9' });

    await world.reset(scenario);
    stopWatching();
    world.apply({ type: 'registry.remove', daemon: 'blue' });

    expect(world.state().update.status).toBe('idle');
    expect(onHint).toHaveBeenCalledOnce();
    world.apply({ type: 'registry.add', daemon: 'blue' });
    await expect(store.load()).resolves.toHaveLength(2);
    expect(world.state().registry.failure).toBeNull();
  });

  it('judges the simulated list as the real store judges a file', async () => {
    const world = createFakeWorld({
      settings: { fake: { scenario: 'basic' } },
      log: { info: vi.fn() },
    } as never);
    await world.reset({
      daemons: [
        { key: 'blue', pm2Home: '/srv/blue/.pm2' },
        { key: 'green', pm2Home: '/srv/green/.pm2' },
      ],
    });
    const store = createDaemonStore({ fakeWorld: world } as never);
    const before = await store.load();

    // An edit from outside may put two daemons at one location, as a hand edit can.
    world.apply({ type: 'registry.edit', daemon: 'blue', pm2Home: '/srv/green/.pm2' });
    await expect(store.load()).rejects.toThrow(/repeats another daemon's location/);
    await expect(store.mutate(current => current ?? [])).rejects.toThrow(DaemonRegistryError);

    world.apply({ type: 'registry.edit', daemon: 'blue', pm2Home: '/srv/blue/.pm2' });
    await expect(store.load()).resolves.toEqual(before);

    // Captain never saves a list it would refuse to read.
    await expect(store.mutate(current => [...current!, current![0]])).rejects.toThrow(
      /repeats another daemon's ID/
    );
    await expect(store.load()).resolves.toEqual(before);
  });
});
