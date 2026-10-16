import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const LAUNCHER = libPath.resolve('support/desktop/appimage/launcher.sh');

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-launcher-'));
  await fs.mkdir(libPath.join(root, 'app'));
  await fs.mkdir(libPath.join(root, 'bin'));
  await fs.copyFile(LAUNCHER, libPath.join(root, 'app/pm2-captain-desktop'));
  await fs.chmod(libPath.join(root, 'app/pm2-captain-desktop'), 0o755);
  // Stands in for Electron: records the arguments it got.
  await fs.writeFile(
    libPath.join(root, 'app/pm2-captain-desktop.bin'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/electron-arguments"\n`,
    { mode: 0o755 }
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Runs the launcher as AppRun would, with user namespaces available or not. */
async function launch(args: string[], { namespaces }: { namespaces: boolean }) {
  await fs.writeFile(libPath.join(root, 'bin/unshare'), `#!/bin/sh\nexit ${namespaces ? 0 : 1}\n`, {
    mode: 0o755,
  });
  // Nothing special in the environment: this is how a user starts it.
  const result = spawnSync(libPath.join(root, 'app/pm2-captain-desktop'), args, {
    encoding: 'utf8',
    env: { PATH: `${libPath.join(root, 'bin')}:/usr/bin:/bin`, DISPLAY: ':99' },
  });
  const electronArguments = await fs
    .readFile(libPath.join(root, 'electron-arguments'), 'utf8')
    .then(content => content.trim().split('\n').filter(Boolean))
    .catch(() => null);
  return { ...result, electronArguments };
}

describe('AppImage launcher', () => {
  it('keeps the sandbox where it works, even when AppRun added --no-sandbox', async () => {
    const result = await launch(['--no-sandbox', '--class=x', 'with space'], { namespaces: true });

    expect(result.status).toBe(0);
    expect(result.electronArguments).toEqual(['--class=x', 'with space']);
    expect(result.stderr).toBe('');
  });

  it('starts without the sandbox where user namespaces are unavailable, with no dialog', async () => {
    const result = await launch(['--class=x'], { namespaces: false });

    expect(result.status).toBe(0);
    expect(result.electronArguments).toEqual(['--no-sandbox', '--class=x']);
    expect(result.stderr).toContain('starting without the Chromium sandbox');
  });

  it('passes --no-sandbox once when AppRun already added it', async () => {
    const result = await launch(['--no-sandbox', '--no-sandbox', 'file'], { namespaces: false });

    expect(result.status).toBe(0);
    expect(result.electronArguments).toEqual(['--no-sandbox', 'file']);
  });
});

describe('AppImage AppArmor profile', () => {
  const PROFILE_SCRIPT = libPath.resolve('support/desktop/appimage/apparmor-profile.sh');

  it('allows user namespaces for exactly one AppImage path', async () => {
    const appImage = libPath.join(root, 'PM2-Captain-x86_64.AppImage');
    await fs.writeFile(appImage, '');

    const result = spawnSync('sh', [PROFILE_SCRIPT, appImage], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `profile pm2-captain-desktop-appimage ${appImage} flags=(default_allow) {`
    );
    expect(result.stdout).toContain('  userns,');
    expect(result.stdout).not.toContain('*');
  });

  it('refuses relative paths, globs and paths that would need quoting', async () => {
    for (const path of [
      'PM2.AppImage',
      '/tmp/*.AppImage',
      '/tmp/my apps/PM2.AppImage',
      '/tmp/x{y}',
    ]) {
      const result = spawnSync('sh', [PROFILE_SCRIPT, path], { encoding: 'utf8' });
      expect(result.status, path).toBe(2);
      expect(result.stdout).toBe('');
    }
  });
});
