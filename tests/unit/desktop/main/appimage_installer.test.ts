import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installAppImage, launchAppImage } from '../../../../src/desktop/main/appimage_installer';

const log = { info: () => undefined, warn: () => undefined } as never;
let root: string;
let appImagePath: string;
let downloadedFile: string;
const sha512 = createHash('sha512').update('new version').digest('base64');

beforeEach(async () => {
  root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-appimage-'));
  await fs.mkdir(libPath.join(root, 'Applications'));
  appImagePath = libPath.join(root, 'Applications/PM2-Captain-x86_64.AppImage');
  downloadedFile = libPath.join(root, 'download.AppImage');
  await fs.writeFile(appImagePath, 'old version', { mode: 0o755 });
  await fs.writeFile(downloadedFile, 'new version');
});

afterEach(async () => {
  await fs.chmod(libPath.join(root, 'Applications'), 0o755).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
});

describe('AppImage installer', () => {
  it('starts the replacement outside the old mount in its own process group', async () => {
    const executable = libPath.join(root, 'Applications', 'replacement executable');
    const report = libPath.join(root, 'started.json');
    await fs.writeFile(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
fs.writeFileSync(process.env.REPORT, JSON.stringify({
  cwd: process.cwd(), args: process.argv.slice(2), pid: process.pid,
  pgid: Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)]).toString().trim()),
  relaunch: process.env.PM2_CAPTAIN_RELAUNCH,
  silent: process.env.APPIMAGE_SILENT_INSTALL,
}));
`,
      { mode: 0o755 }
    );

    await launchAppImage(executable, ['argument with spaces', '--remote-debugging-port=1234'], {
      ...process.env,
      REPORT: report,
      PM2_CAPTAIN_RELAUNCH: '1',
    });

    await expect
      .poll(() => fs.readFile(report, 'utf8').then(JSON.parse))
      .toMatchObject({
        cwd: libPath.dirname(executable),
        args: ['argument with spaces', '--remote-debugging-port=1234'],
        relaunch: '1',
        silent: 'true',
      });
    const started = JSON.parse(await fs.readFile(report, 'utf8'));
    expect(started.pgid).toBe(started.pid);
    const parentGroup = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)]));
    expect(started.pgid).not.toBe(parentGroup);
  });

  it('reports an exec failure before the running app exits', async () => {
    await expect(launchAppImage(libPath.join(root, 'missing'), [], {})).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('replaces the file in place, executable, and leaves nothing behind', async () => {
    const before = await fs.stat(appImagePath);

    await expect(
      installAppImage({ appImagePath, file: downloadedFile, sha512 }, log)
    ).resolves.toEqual({
      kind: 'installed',
    });

    expect(await fs.readFile(appImagePath, 'utf8')).toBe('new version');
    const after = await fs.stat(appImagePath);
    expect(after.mode & 0o777).toBe(0o755);
    // A new file took the old name: the running app keeps the old inode.
    expect(after.ino).not.toBe(before.ino);
    expect(await fs.readdir(libPath.join(root, 'Applications'))).toEqual([
      'PM2-Captain-x86_64.AppImage',
    ]);
  });

  it('keeps the old AppImage when the folder is not writable', async () => {
    await fs.chmod(libPath.join(root, 'Applications'), 0o555);

    const outcome = await installAppImage({ appImagePath, file: downloadedFile, sha512 }, log);

    expect(outcome.kind).toBe('not-started');
    expect(await fs.readFile(appImagePath, 'utf8')).toBe('old version');
  });

  it('keeps the old AppImage when the download does not match its checksum', async () => {
    const outcome = await installAppImage(
      { appImagePath, file: downloadedFile, sha512: 'wrong' },
      log
    );

    expect(outcome.kind).toBe('not-started');
    expect(await fs.readFile(appImagePath, 'utf8')).toBe('old version');
    expect(await fs.readdir(libPath.join(root, 'Applications'))).toEqual([
      'PM2-Captain-x86_64.AppImage',
    ]);
  });

  it('refuses a missing or relative AppImage path', async () => {
    for (const path of ['PM2-Captain-x86_64.AppImage', libPath.join(root, 'missing.AppImage')]) {
      const outcome = await installAppImage(
        { appImagePath: path, file: downloadedFile, sha512 },
        log
      );
      expect(outcome.kind).toBe('not-started');
    }
  });
});
