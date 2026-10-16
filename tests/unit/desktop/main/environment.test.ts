import { describe, expect, it } from 'vitest';

import { createBackendEnvironment } from '../../../../src/desktop/main/environment';

describe('backend environment', () => {
  it('keeps the user environment without Electron and app variables', () => {
    const environment = createBackendEnvironment(
      {
        HOME: '/home/u',
        PATH: '/usr/bin:/bin',
        SSH_AUTH_SOCK: '/run/agent.sock',
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_NO_ATTACH_CONSOLE: '1',
        CHROME_DESKTOP: 'x.desktop',
        NODE_OPTIONS: '--require /tmp/evil.js',
        PM2_CAPTAIN_DESKTOP_FAKE: 'basic',
        PM2_HOME: '/srv/pm2',
      },
      'linux'
    );

    expect(environment).toEqual({
      HOME: '/home/u',
      PATH: '/usr/bin:/bin',
      SSH_AUTH_SOCK: '/run/agent.sock',
      PM2_HOME: '/srv/pm2',
    });
  });

  it('adds the usual macOS package directories that exist to a Finder PATH', () => {
    const environment = createBackendEnvironment(
      { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      'darwin',
      path => path === '/opt/homebrew/bin'
    );

    expect(environment.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin');
  });
});
