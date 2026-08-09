import { describe, expect, it } from 'vitest';

import { SshConnectionError, parseRemoteInfo } from './ssh_connection';

describe('sshConnection', () => {
  it('parses discovered PM2 and host information', () => {
    expect(
      parseRemoteInfo('login banner\n__PM2_CAPTAIN_REMOTE__\n/srv/pm2\ndeploy\napp-01\n')
    ).toEqual({
      pm2Home: '/srv/pm2',
      username: 'deploy',
      hostname: 'app-01',
    });
  });

  it('rejects malformed discovery output and unsupported socket paths', () => {
    expect(() => parseRemoteInfo('__PM2_CAPTAIN_REMOTE__\n/srv/pm2\ndeploy\n')).toThrow(
      SshConnectionError
    );
    expect(() =>
      parseRemoteInfo('__PM2_CAPTAIN_REMOTE__\n/srv/pm2:blue\ndeploy\napp-01\n')
    ).toThrow('Unable to determine');
  });
});
