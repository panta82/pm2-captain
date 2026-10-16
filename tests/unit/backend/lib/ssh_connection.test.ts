import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { listOwnedProcessIds } from '../../../../src/backend/lib/owned_processes';
import {
  SshConnectionError,
  createSshConnection,
  parseRemoteInfo,
} from '../../../../src/backend/lib/ssh_connection';

const originalPath = process.env.PATH;
let root: string | null = null;

afterEach(async () => {
  process.env.PATH = originalPath;
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
    root = null;
  }
});

/** Puts a fake `ssh` first on PATH. It never contacts a real host. */
async function installFakeSsh(script: string) {
  root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2-captain-fake-ssh-'));
  const bin = libPath.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(libPath.join(bin, 'ssh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${originalPath}`;
  return root;
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const connect = (runtime: 'cli' | 'desktop') =>
  createSshConnection({
    settings: { sshArgs: ['fake-host'], pm2Home: null, runtime },
    log: { info: vi.fn(), warn: vi.fn() },
  } as never);

const DISCOVERY = 'login banner\n__PM2_CAPTAIN_REMOTE__\n/srv/pm2\ndeploy\napp-01\n/home/deploy\n';

describe('sshConnection', () => {
  it('parses discovered PM2 and host information', () => {
    expect(parseRemoteInfo(DISCOVERY)).toEqual({
      pm2Home: '/srv/pm2',
      username: 'deploy',
      hostname: 'app-01',
    });
  });

  it('prefers a configured PM2 home and resolves ~ against the remote home', () => {
    expect(parseRemoteInfo(DISCOVERY, '/opt/pm2').pm2Home).toBe('/opt/pm2');
    expect(parseRemoteInfo(DISCOVERY, '~/.pm2-staging').pm2Home).toBe('/home/deploy/.pm2-staging');
    expect(parseRemoteInfo(DISCOVERY, '~').pm2Home).toBe('/home/deploy');
  });

  it('rejects malformed discovery output and unsupported socket paths', () => {
    expect(() => parseRemoteInfo('__PM2_CAPTAIN_REMOTE__\n/srv/pm2\ndeploy\n')).toThrow(
      SshConnectionError
    );
    expect(() =>
      parseRemoteInfo('__PM2_CAPTAIN_REMOTE__\n/srv/pm2:blue\ndeploy\napp-01\n/home/deploy\n')
    ).toThrow('Unable to determine');
    expect(() =>
      parseRemoteInfo('__PM2_CAPTAIN_REMOTE__\n/srv/pm2\ndeploy\napp-01\n/home/de:ploy\n', '~/x')
    ).toThrow('Unable to determine');
  });

  it.each(['cli', 'desktop'] as const)(
    'ends a hanging discovery and its helper processes when stopped (%s)',
    async runtime => {
      const directory = await installFakeSsh(
        // Like a ProxyCommand: a helper that would outlive a killed ssh.
        'sleep 600 & echo $! > "$(dirname "$0")/../helper.pid"; echo $$ > "$(dirname "$0")/../ssh.pid"; wait'
      );
      const connection = connect(runtime);
      await connection.initialize();
      const starting = connection.start();
      const readPid = async (name: string) => {
        await vi.waitFor(() => fs.access(libPath.join(directory, name)), { timeout: 5_000 });
        return Number(await fs.readFile(libPath.join(directory, name), 'utf8'));
      };
      const sshPid = await readPid('ssh.pid');
      const helperPid = await readPid('helper.pid');
      expect(listOwnedProcessIds()).toContain(sshPid);

      const startedAt = Date.now();
      await connection.dispose();
      await expect(starting).rejects.toThrow('shutting down');

      expect(Date.now() - startedAt).toBeLessThan(3_000);
      await vi.waitFor(() => expect(isAlive(sshPid)).toBe(false), { timeout: 3_000 });
      expect(listOwnedProcessIds()).not.toContain(sshPid);
      if (runtime === 'desktop') {
        // Its own process group: the helper ends with it.
        await vi.waitFor(() => expect(isAlive(helperPid)).toBe(false), { timeout: 3_000 });
      } else {
        process.kill(helperPid, 'SIGKILL');
      }
    },
    15_000
  );

  it('ends a helper that ignores SIGTERM when the desktop app stops SSH', async () => {
    const directory = await installFakeSsh(
      `(trap '' TERM; exec sleep 600) & echo $! > "$(dirname "$0")/../helper.pid"; wait`
    );
    const connection = connect('desktop');
    const starting = connection.start();
    await vi.waitFor(() => fs.access(libPath.join(directory, 'helper.pid')), { timeout: 5_000 });
    const helperPid = Number(await fs.readFile(libPath.join(directory, 'helper.pid'), 'utf8'));

    await connection.dispose();
    await expect(starting).rejects.toThrow('shutting down');

    await vi.waitFor(() => expect(isAlive(helperPid)).toBe(false), { timeout: 3_000 });
  }, 15_000);

  it('explains what SSH needs when it cannot connect on its own', async () => {
    await installFakeSsh('echo "Permission denied (publickey)." >&2; exit 255');
    const connection = connect('desktop');

    const error = await connection.start().catch(error => error);

    expect(error).toBeInstanceOf(SshConnectionError);
    expect(error.message).toContain('Permission denied (publickey).');
    expect(error.message).toContain('without a terminal');
  });

  it('says where it looked when ssh is not installed', async () => {
    root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2-captain-no-ssh-'));
    process.env.PATH = root;
    const connection = connect('desktop');

    const error = await connection.start().catch(error => error);

    expect(error.message).toContain('The ssh command was not found');
    expect(error.message).toContain(root);
  });
});
