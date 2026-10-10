import { describe, expect, it } from 'vitest';

import { SshConnectionError, parseRemoteInfo } from '../../../../src/backend/lib/ssh_connection';

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
});
