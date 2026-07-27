import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadBackendSettings } from './backend_settings';

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
});
