import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createCaptainLauncher,
  resolveBrowserOpenCommand,
} from '../../../../src/backend/bl/captain_launcher';

const url = 'http://127.0.0.1:3212';

describe('browser link support', () => {
  it('uses xdg-open when a Linux desktop and executable are available', () => {
    const resolveExecutable = vi.fn(() => '/usr/bin/xdg-open');

    expect(
      resolveBrowserOpenCommand(
        url,
        'linux',
        { DISPLAY: ':0', PATH: '/usr/bin' },
        resolveExecutable
      )
    ).toEqual(['/usr/bin/xdg-open', [url]]);
  });

  it('does not claim browser support in a headless Linux environment', () => {
    const resolveExecutable = vi.fn(() => '/usr/bin/xdg-open');

    expect(
      resolveBrowserOpenCommand(url, 'linux', { PATH: '/usr/bin' }, resolveExecutable)
    ).toBeNull();
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it('does not claim browser support when xdg-open is unavailable', () => {
    expect(
      resolveBrowserOpenCommand(url, 'linux', { DISPLAY: ':0', PATH: '/usr/bin' }, () => null)
    ).toBeNull();
  });

  it('detects the native macOS opener', () => {
    expect(
      resolveBrowserOpenCommand(url, 'darwin', { PATH: '/usr/bin' }, () => '/usr/bin/open')
    ).toEqual(['/usr/bin/open', [url]]);
  });
});

describe('launch token', () => {
  it('lives in a private config directory and survives restarts', async () => {
    const root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2-captain-launcher-'));
    const configDir = libPath.join(root, 'config', 'pm2-captain');
    const launch = async () => {
      const launcher = createCaptainLauncher({
        settings: { configDir, noAuth: false },
        log: { warn: vi.fn() },
      } as never);
      await launcher.initialize();
      return launcher;
    };
    try {
      const launcher = await launch();
      const tokenPath = libPath.join(configDir, 'launch-token');
      const token = (await fs.readFile(tokenPath, 'utf8')).trim();

      expect(token).toMatch(/^[\w-]{43}$/);
      expect((await fs.stat(configDir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(tokenPath)).mode & 0o777).toBe(0o600);
      expect(launcher.authenticate(token)).toBe(true);
      expect(launcher.authenticate(`${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`)).toBe(false);
      expect(launcher.authenticate(undefined)).toBe(false);
      expect((await launch()).authenticate(token)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
