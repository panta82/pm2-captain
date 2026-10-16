import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DaemonRegistryError, createDaemonStore } from '../../../../src/backend/lib/daemon_store';
import type { IDaemonConfig } from '../../../../src/shared/contracts';

const directories: string[] = [];
const stops: Array<() => void> = [];

afterEach(async () => {
  stops.splice(0).forEach(stop => stop());
  await Promise.all(
    directories.splice(0).map(path => fs.rm(path, { recursive: true, force: true }))
  );
});

const LOCAL: IDaemonConfig = {
  daemonId: '830f902f-c88b-4ed8-8051-c3a81c44ed87',
  kind: 'local',
  pm2Home: '/home/deploy/.pm2',
};
const REMOTE: IDaemonConfig = {
  daemonId: 'b61e3d2f-b6d1-4af2-8e2f-6bb3fdf1f7fa',
  kind: 'ssh',
  sshArgs: ['-p', '2222', '-o', 'IdentityFile=/secret/key', 'deploy@example.com'],
  pm2Home: '~/.pm2-staging',
  label: 'staging',
};

async function setup() {
  const root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2-captain-daemon-store-'));
  directories.push(root);
  const configDir = libPath.join(root, 'config', 'pm2-captain');
  const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
  return {
    root,
    configDir,
    log,
    path: libPath.join(configDir, 'daemons.json'),
    store: createDaemonStore({ settings: { configDir }, log } as never),
  };
}

const writeRegistry = async (path: string, daemons: unknown) => {
  await fs.mkdir(libPath.dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify({ version: 1, daemons }, null, 2));
};

describe('daemonStore', () => {
  it('tells a list that was never set up from one the user emptied', async () => {
    const { path, store } = await setup();

    await expect(store.load()).resolves.toBeNull();
    await store.mutate(() => []);
    await expect(store.load()).resolves.toEqual([]);

    await fs.writeFile(path, '{"version":1,"daemons":null}');
    await expect(store.load()).resolves.toBeNull();
  });

  it('persists readable JSON with private permissions', async () => {
    const { configDir, path, store } = await setup();

    await store.mutate(() => [LOCAL, REMOTE]);

    await expect(store.load()).resolves.toEqual([LOCAL, REMOTE]);
    expect(await fs.readFile(path, 'utf8')).toContain('\n    {\n      "daemonId"');
    expect((await fs.stat(configDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    // Neither temporary files nor the lock are left behind.
    expect(await fs.readdir(configDir)).toEqual(['daemons.json']);
  });

  it('applies a change to what is on disk now, not to what was read before', async () => {
    const { path, store } = await setup();
    await store.mutate(() => [LOCAL]);
    // Another program adds a daemon.
    await writeRegistry(path, [LOCAL, REMOTE]);

    const saved = await store.mutate(current => current!.filter(daemon => daemon !== current![0]));

    expect(saved).toEqual([REMOTE]);
    await expect(store.load()).resolves.toEqual([REMOTE]);
  });

  it('does not rewrite the file for a change that changes nothing', async () => {
    const { path, store } = await setup();
    await store.mutate(() => [LOCAL]);
    const before = await fs.stat(path);

    await store.mutate(current => current!.slice());

    expect((await fs.stat(path)).ino).toBe(before.ino);
  });

  it('keeps every change when two processes save at the same time', async () => {
    const { configDir, store } = await setup();
    const writer = libPath.resolve('tests/support/registry_writer.ts');
    const run = (prefix: string) =>
      promisify(execFile)(process.execPath, ['--import', 'tsx', writer, configDir, '15', prefix], {
        timeout: 30_000,
      });

    await Promise.all([
      run('first'),
      run('second'),
      (async () => {
        for (let index = 0; index < 15; index++) {
          await store.mutate(current => [
            ...(current ?? []),
            { daemonId: randomUUID(), kind: 'local', pm2Home: `/srv/here-${index}` },
          ]);
        }
      })(),
    ]);

    const homes = (await store.load())!.map(daemon => daemon.pm2Home ?? '');
    expect(homes).toHaveLength(45);
    for (const prefix of ['first', 'second', 'here']) {
      expect(homes.filter(home => home.startsWith(`/srv/${prefix}-`))).toHaveLength(15);
    }
  }, 60_000);

  it('recovers a lock that its owner abandoned', async () => {
    const { configDir, store } = await setup();
    const lockPath = libPath.join(configDir, '.daemons.lock');
    await fs.mkdir(lockPath, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);

    await expect(store.mutate(() => [LOCAL])).resolves.toEqual([LOCAL]);
  });

  it('reports a broken file without its contents and leaves it alone', async () => {
    const { configDir, path, store } = await setup();
    await fs.mkdir(configDir, { recursive: true });
    const broken = '{"version":1,"daemons":[{"kind":"ssh","sshArgs":["-o","Password=hunter2"';
    await fs.writeFile(path, broken);

    const error = await store.load().catch(error => error);
    expect(error).toBeInstanceOf(DaemonRegistryError);
    expect(error.message).not.toContain('hunter2');
    await expect(store.mutate(() => [LOCAL])).rejects.toBeInstanceOf(DaemonRegistryError);
    await expect(fs.readFile(path, 'utf8')).resolves.toBe(broken);
  });

  it('rejects entries that would be ambiguous or that Captain cannot use', async () => {
    const { path, store } = await setup();

    await writeRegistry(path, [LOCAL, { ...REMOTE, daemonId: LOCAL.daemonId }]);
    await expect(store.load()).rejects.toThrow(/repeats another daemon's ID/);

    await writeRegistry(path, [
      LOCAL,
      { ...LOCAL, daemonId: REMOTE.daemonId, pm2Home: '/home/deploy/.pm2/' },
    ]);
    await expect(store.load()).rejects.toThrow(/repeats another daemon's location/);

    await writeRegistry(path, [{ ...LOCAL, daemonId: 'local-1' }]);
    await expect(store.load()).rejects.toThrow(/UUID/);

    await expect(store.mutate(() => [{ ...LOCAL, pm2Home: '.pm2' }])).rejects.toThrow();
  });

  it('refuses to replace a symbolic link', async () => {
    const { root, path, store } = await setup();
    const target = libPath.join(root, 'dotfiles-daemons.json');
    await writeRegistry(target, [LOCAL]);
    await fs.mkdir(libPath.dirname(path), { recursive: true });
    await fs.symlink(target, path);

    await expect(store.load()).rejects.toThrow(/symbolic link/);
    await expect(store.mutate(() => [REMOTE])).rejects.toThrow(/symbolic link/);
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(true);
  });

  it('notices an atomic replacement of the file', async () => {
    const { configDir, path, store } = await setup();
    await store.mutate(() => [LOCAL]);
    const onHint = vi.fn();
    stops.push(await store.watch(onHint));

    const temporary = libPath.join(configDir, 'daemons.json.editor-swap');
    await fs.writeFile(temporary, JSON.stringify({ version: 1, daemons: [REMOTE] }));
    await fs.rename(temporary, path);

    await vi.waitFor(() => expect(onHint).toHaveBeenCalled(), { timeout: 2_000 });
    await expect(store.load()).resolves.toEqual([REMOTE]);
  });

  it('watches again after its directory is replaced even if its inode is reused', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    let stat: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const { configDir, path, store, log } = await setup();
      await store.mutate(() => [LOCAL]);
      // Make inode reuse deterministic; fs.watch still observes real deletion
      // and recreation, so only reopening it can see subsequent file edits.
      stat = vi.spyOn(fs, 'stat').mockResolvedValue(await fs.stat(configDir));
      const onHint = vi.fn();
      stops.push(await store.watch(onHint));

      await fs.rm(configDir, { recursive: true });
      await writeRegistry(path, [REMOTE]);
      onHint.mockClear();
      // The periodic rescan reports a possible change and arms a new watcher.
      vi.advanceTimersByTime(30_000);
      await vi.waitFor(() => expect(onHint).toHaveBeenCalled(), { timeout: 2_000 });

      onHint.mockClear();
      await writeRegistry(path, [LOCAL]);
      await vi.waitFor(() => expect(onHint).toHaveBeenCalled(), { timeout: 2_000 });
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Unable to create')
      );
    } finally {
      stat?.mockRestore();
      vi.useRealTimers();
    }
  });
});
