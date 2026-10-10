import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPm2HomeFinder, parseDaemonHomes } from '../../../../src/backend/lib/pm2_home_finder';

const mocked = vi.hoisted(() => ({
  psOutput: '' as string | Error,
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: object,
      callback: (error: Error | null, stdout: string) => void
    ) => {
      const output = mocked.psOutput;
      callback(output instanceof Error ? output : null, output instanceof Error ? '' : output);
    }
  ),
}));

vi.mock('node:child_process', () => ({ execFile: mocked.execFile }));

describe('parseDaemonHomes', () => {
  it('reads PM2 homes from daemon titles of the given user', () => {
    const output = [
      '    0 PM2 v6.0.14: God Daemon (/root/.pm2)',
      ' 1000 PM2 v6.0.14: God Daemon (/home/deploy/.pm2)',
      ' 1000 PM2 v7.0.3: God Daemon (/srv/pm2 (blue))',
      ' 1000 node /srv/app/server.js',
      ' 1000 PM2 v7.0.3: God Daemon (relative/home)',
      '',
    ].join('\n');

    expect(parseDaemonHomes(output, 1000)).toEqual(['/home/deploy/.pm2', '/srv/pm2 (blue)']);
    expect(parseDaemonHomes(output, null)).toHaveLength(3);
  });
});

describe('pm2HomeFinder', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2-captain-finder-')));
    vi.spyOn(libOs, 'homedir').mockReturnValue(libPath.join(root, 'home'));
    mocked.psOutput = '';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  const makeHome = async (path: string, files: string[]) => {
    await fs.mkdir(path, { recursive: true });
    for (const file of files) {
      await fs.writeFile(libPath.join(path, file), '');
    }
    return path;
  };

  const find = (environmentPm2Home: string | null = null) =>
    createPm2HomeFinder({
      settings: { environmentPm2Home },
      log: { debug: vi.fn() },
    } as never).find();

  it('finds the default home, PM2_HOME and running daemons once each', async () => {
    const defaultHome = await makeHome(libPath.join(root, 'home', '.pm2'), ['pm2.log']);
    const environmentHome = await makeHome(libPath.join(root, 'env-pm2'), ['rpc.sock']);
    const runningHome = await makeHome(libPath.join(root, 'running-pm2'), ['rpc.sock']);
    await fs.symlink(runningHome, libPath.join(root, 'running-link'));
    const uid = process.getuid?.() ?? 0;
    mocked.psOutput = [
      `${uid} PM2 v7.0.3: God Daemon (${runningHome})`,
      `${uid} PM2 v7.0.3: God Daemon (${libPath.join(root, 'running-link')})`,
      `${uid} PM2 v7.0.3: God Daemon (${environmentHome})`,
    ].join('\n');

    await expect(find(environmentHome)).resolves.toEqual([
      defaultHome,
      environmentHome,
      runningHome,
    ]);
  });

  it('ignores directories where no PM2 daemon has run', async () => {
    // Importing the pm2 package leaves exactly this behind in ~/.pm2.
    await makeHome(libPath.join(root, 'home', '.pm2', 'logs'), []);
    await makeHome(libPath.join(root, 'home', '.pm2'), ['module_conf.json']);
    mocked.psOutput = new Error('ps is not available');

    await expect(find(libPath.join(root, 'does-not-exist'))).resolves.toEqual([]);
  });
});
