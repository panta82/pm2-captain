import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  InstallPreconditionError,
  createLinuxInstaller,
  manualInstallCommand,
} from '../../../../src/desktop/main/linux_installer';

let root: string;
let packagePath: string;
let sha512: string;

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

beforeEach(async () => {
  root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-installer-'));
  packagePath = libPath.join(root, 'pm2-captain-desktop_1.6.0_amd64.deb');
  await fs.writeFile(packagePath, 'not really a package');
  sha512 = createHash('sha512').update('not really a package').digest('base64');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A stand-in for pkexec: records its arguments, then runs `body`. Nothing is elevated. */
async function fakePkexec(body: string) {
  const path = libPath.join(root, 'pkexec');
  await fs.writeFile(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/arguments"\necho "installer output"\n${body}\n`,
    { mode: 0o755 }
  );
  return path;
}

async function setup(pkexecBody = 'exit 0', fields = 'pm2-captain-desktop\n1.6.0\namd64\n') {
  const pkexecPath = await fakePkexec(pkexecBody);
  const tool = libPath.join(root, 'tool');
  await fs.writeFile(tool, '', { mode: 0o755 });
  const directory = libPath.join(root, 'profile');
  await fs.mkdir(directory);
  const run = vi.fn(async () => ({ stdout: fields }));
  const installer = createLinuxInstaller({
    directory,
    currentVersion: '1.5.0',
    arch: 'x64',
    log,
    run,
    pkexecPath,
    packageTools: {
      deb: { install: '/usr/bin/dpkg', inspect: tool },
      rpm: { install: '/usr/bin/rpm', inspect: tool },
    },
  });
  return { installer, run, directory };
}

const request = (packageType: 'deb' | 'rpm' = 'deb') => ({
  packageType,
  file: packagePath,
  version: '1.6.0',
  sha512,
});

describe('linux installer', () => {
  it('checks the package before anything is stopped or elevated', async () => {
    const { installer, run } = await setup();
    await expect(installer.verify(request())).resolves.toBeUndefined();
    expect((run.mock.calls[0] as unknown[])[1]).toContain(packagePath);

    await expect(installer.verify({ ...request(), sha512: 'wrong' })).rejects.toThrow('checksum');
    for (const fields of [
      'pm2-captain\n1.6.0\namd64\n',
      'pm2-captain-desktop\n1.5.0\namd64\n',
      'pm2-captain-desktop\n1.6.0\narm64\n',
    ]) {
      run.mockResolvedValueOnce({ stdout: fields });
      await expect(installer.verify(request())).rejects.toBeInstanceOf(InstallPreconditionError);
    }
  });

  it('runs one fixed command per package type, without a shell', async () => {
    const { installer } = await setup();

    await installer.install(request('deb'));
    expect((await fs.readFile(libPath.join(root, 'arguments'), 'utf8')).trim().split('\n')).toEqual(
      ['/usr/bin/dpkg', '--refuse-downgrade', '--install', packagePath]
    );
    await installer.install(request('rpm'));
    expect((await fs.readFile(libPath.join(root, 'arguments'), 'utf8')).trim().split('\n')).toEqual(
      ['/usr/bin/rpm', '--upgrade', packagePath]
    );
  });

  it('clears its marker after a successful installation', async () => {
    const { installer } = await setup('exit 0');

    await expect(installer.install(request())).resolves.toEqual({ kind: 'installed' });

    expect(installer.readMarker()).toBeNull();
    expect(installer.readLogTail()).toContain('installer output');
  });

  it.each([126, 127])('treats pkexec exit %i as an installation that never started', async code => {
    const { installer } = await setup(`exit ${code}`);

    const outcome = await installer.install(request());

    expect(outcome.kind).toBe('not-started');
    expect(installer.readMarker()).toBeNull();
  });

  it.each(['exit 1', 'exit 2', 'kill -TERM $$'])(
    'keeps the marker when the package manager fails (%s)',
    async body => {
      const { installer } = await setup(body);

      const outcome = await installer.install(request());

      expect(outcome.kind).toBe('uncertain');
      const marker = installer.readMarker();
      expect(marker).toMatchObject({ targetVersion: '1.6.0', fromVersion: '1.5.0' });
      expect(marker!.exitCode !== null || marker!.signal !== null).toBe(true);
    }
  );

  it('reports a failure to prepare as not started, and leaves no marker', async () => {
    const { installer, directory } = await setup();
    // The log path is a directory, so opening it fails before anything runs.
    await fs.mkdir(libPath.join(directory, 'update-install.log'));

    await expect(installer.install(request())).resolves.toMatchObject({ kind: 'not-started' });
    expect(installer.readMarker()).toBeNull();
  });

  it('treats an existing marker it cannot read as an unresolved installation', async () => {
    const { installer, directory } = await setup();
    const markerPath = libPath.join(directory, 'update-install.json');

    for (const content of [
      '{not json',
      '{"version":2}',
      '{"version":1,"packageType":"exe"}',
      '[]',
    ]) {
      await fs.writeFile(markerPath, content);
      expect(installer.readMarker()).not.toBeNull();
    }
    installer.clearMarker();
    expect(installer.readMarker()).toBeNull();
  });

  it('lets a running installation finish and keeps its marker when the app is killed', async () => {
    const { directory } = await setup();
    const pkexecPath = await fakePkexec(`sleep 1; touch "${root}/finished"; exit 0`);
    const script = `
      const { createLinuxInstaller } = require(${JSON.stringify(libPath.resolve('src/desktop/main/linux_installer.ts'))});
      const log = { info() {}, warn() {}, error() {}, debug() {} };
      const installer = createLinuxInstaller({ directory: ${JSON.stringify(directory)}, currentVersion: '1.5.0', log, pkexecPath: ${JSON.stringify(pkexecPath)} });
      installer.install({ packageType: 'deb', file: ${JSON.stringify(packagePath)}, version: '1.6.0', sha512: '' });
      setTimeout(() => process.stdout.write('started\\n'), 200);
    `;
    const app = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>(resolve => app.stdout.once('data', () => resolve()));
    app.kill('SIGKILL');

    await vi.waitFor(() => fs.access(libPath.join(root, 'finished')), { timeout: 5_000 });
    const marker = JSON.parse(
      await fs.readFile(libPath.join(directory, 'update-install.json'), 'utf8')
    );
    expect(marker).toMatchObject({ version: 1, targetVersion: '1.6.0', exitCode: null });
    expect(marker.pid).toEqual(expect.any(Number));
  });

  it('quotes the manual recovery command', () => {
    expect(manualInstallCommand('deb', "/tmp/it's.deb")).toBe("sudo dpkg -i '/tmp/it'\\''s.deb'");
    expect(manualInstallCommand('rpm', '/tmp/a.rpm')).toBe("sudo rpm -U '/tmp/a.rpm'");
  });
});
