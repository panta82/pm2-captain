import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDaemonStore } from '../../../../src/backend/lib/daemon_store';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(path => fs.rm(path, { recursive: true, force: true }))
  );
});

async function setup() {
  const root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2-captain-daemon-store-'));
  directories.push(root);
  const configDir = libPath.join(root, 'config', 'pm2-captain');
  return {
    configDir,
    path: libPath.join(configDir, 'daemons.json'),
    store: createDaemonStore({ settings: { configDir } } as never),
  };
}

describe('daemonStore', () => {
  it('tells a list that was never set up from one the user emptied', async () => {
    const { path, store } = await setup();

    await expect(store.load()).resolves.toBeNull();
    await store.save([]);
    await expect(store.load()).resolves.toEqual([]);

    await fs.writeFile(path, '{"version":1,"daemons":null}');
    await expect(store.load()).resolves.toBeNull();
  });

  it('persists local and SSH daemons with private permissions', async () => {
    const { configDir, path, store } = await setup();
    const daemons = [
      {
        daemonId: '830f902f-c88b-4ed8-8051-c3a81c44ed87',
        kind: 'local' as const,
        pm2Home: '/home/deploy/.pm2',
      },
      {
        daemonId: 'b61e3d2f-b6d1-4af2-8e2f-6bb3fdf1f7fa',
        kind: 'ssh' as const,
        sshArgs: ['-p', '2222', 'deploy@example.com'],
        pm2Home: '~/.pm2-staging',
        label: 'staging',
      },
    ];

    await store.save(daemons);

    await expect(store.load()).resolves.toEqual(daemons);
    expect((await fs.stat(configDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  });

  it('rejects a malformed registry without replacing it', async () => {
    const { configDir, path, store } = await setup();
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path, '{"version":1,"daemons":[{"kind":"ssh"}]}');

    await expect(store.load()).rejects.toThrow();
    await expect(fs.readFile(path, 'utf8')).resolves.toContain('"kind":"ssh"');
  });

  it('refuses a relative local PM2 home', async () => {
    const { store } = await setup();

    await expect(
      store.save([
        { daemonId: '830f902f-c88b-4ed8-8051-c3a81c44ed87', kind: 'local', pm2Home: '.pm2' },
      ])
    ).rejects.toThrow();
  });
});
