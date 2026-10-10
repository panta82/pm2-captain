import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadBackendSettings } from '../../../src/backend/backend_settings';

const originalArgv = process.argv;
const originalPm2Home = process.env.PM2_HOME;

afterEach(() => {
  process.argv = originalArgv;
  if (originalPm2Home === undefined) {
    delete process.env.PM2_HOME;
  } else {
    process.env.PM2_HOME = originalPm2Home;
  }
  vi.unstubAllEnvs();
});

describe('backend settings', () => {
  it('keeps authentication enabled by default', () => {
    process.argv = ['node', 'pm2-captain'];
    vi.stubEnv('PM2_HOME', '/tmp/pm2-captain-settings-test');
    vi.stubEnv('PM2_CAPTAIN_NO_AUTH', '');

    expect(loadBackendSettings().noAuth).toBe(false);
  });

  it('disables authentication through the CLI', () => {
    process.argv = ['node', 'pm2-captain', '--no-auth'];
    vi.stubEnv('PM2_HOME', '/tmp/pm2-captain-settings-test');

    expect(loadBackendSettings().noAuth).toBe(true);
  });

  it('disables authentication through the environment', () => {
    process.argv = ['node', 'pm2-captain'];
    vi.stubEnv('PM2_HOME', '/tmp/pm2-captain-settings-test');
    vi.stubEnv('PM2_CAPTAIN_NO_AUTH', 'true');

    expect(loadBackendSettings().noAuth).toBe(true);
  });

  it.each([
    [[], '', 'auto'],
    [['--open'], '', 'always'],
    [['--no-open'], '', 'never'],
    [[], 'true', 'never'],
    [['--open'], 'true', 'always'],
  ])('resolves browser opening for %j with PM2_CAPTAIN_NO_OPEN=%j', (args, noOpen, expected) => {
    process.argv = ['node', 'pm2-captain', ...args];
    vi.stubEnv('PM2_HOME', '/tmp/pm2-captain-settings-test');
    vi.stubEnv('PM2_CAPTAIN_NO_OPEN', noOpen);

    expect(loadBackendSettings().browserOpen).toBe(expected);
  });

  it('passes every argument after the ssh subcommand to SSH', () => {
    process.argv = [
      'node',
      'pm2-captain',
      '--port',
      '4321',
      'ssh',
      '-p',
      '2222',
      'captain@example.com',
    ];
    vi.stubEnv('PM2_HOME', '/tmp/pm2-captain-settings-test');

    const settings = loadBackendSettings();

    expect(settings.port).toBe(4321);
    expect(settings.sshArgs).toEqual(['-p', '2222', 'captain@example.com']);
  });

  it('requires an SSH destination', () => {
    process.argv = ['node', 'pm2-captain', 'ssh'];
    vi.stubEnv('PM2_HOME', '/tmp/pm2-captain-settings-test');

    expect(() => loadBackendSettings()).toThrow('requires a destination');
  });
});
