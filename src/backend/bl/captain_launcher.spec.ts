import { describe, expect, it, vi } from 'vitest';

import { resolveBrowserOpenCommand } from './captain_launcher';

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
