import { describe, expect, it } from 'vitest';

import {
  APP_SERVICES,
  DAEMON_SERVICES,
  FAKE_APP_SERVICES,
  FAKE_DAEMON_SERVICES,
} from '../../../src/backend/container';

const identifiers = (services: readonly { identifier: string }[]) =>
  services.map(service => service.identifier);

describe('service lists', () => {
  it('keep everything fake out of a normal Captain', () => {
    expect(identifiers(APP_SERVICES)).not.toContain('fakeWorld');
    expect(identifiers(APP_SERVICES)).not.toContain('fakeControl');
    expect(identifiers(DAEMON_SERVICES)).not.toContain('fakeWorld');
    for (const service of [...APP_SERVICES, ...DAEMON_SERVICES]) {
      expect((FAKE_APP_SERVICES as readonly object[]).includes(service)).toBe(
        [
          'logger',
          'log',
          'app',
          'keybindingStore',
          'daemonManager',
          'sessionAuth',
          'captainLauncher',
          'webServer',
        ].includes(service.identifier)
      );
    }
  });

  it('keep everything that reaches PM2, SSH or the daemon registry out of fake mode', () => {
    const real = new Set<object>([...APP_SERVICES, ...DAEMON_SERVICES]);
    const replaced = [...FAKE_APP_SERVICES, ...FAKE_DAEMON_SERVICES].filter(
      service => !real.has(service)
    );

    expect(identifiers(FAKE_DAEMON_SERVICES)).toEqual([
      'logger',
      'log',
      'app',
      'pm2Daemon',
      'processManager',
      'logManager',
    ]);
    expect(identifiers(replaced).sort()).toEqual([
      'appUpdates',
      'daemonStore',
      'fakeControl',
      'fakeWorld',
      'pm2Daemon',
      'pm2HomeFinder',
    ]);
  });

  it('load the world before the services that read it', () => {
    const order = identifiers(FAKE_APP_SERVICES);

    expect(order.indexOf('fakeWorld')).toBeLessThan(order.indexOf('daemonStore'));
    expect(order.indexOf('fakeWorld')).toBeLessThan(order.indexOf('daemonManager'));
    expect(order.indexOf('fakeWorld')).toBeLessThan(order.indexOf('appUpdates'));
  });
});
