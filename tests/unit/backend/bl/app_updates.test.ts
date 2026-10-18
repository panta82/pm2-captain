import { describe, expect, it } from 'vitest';

import appUpdatesDefinition, {
  AppUpdatesUnavailableError,
} from '../../../../src/backend/bl/app_updates';
import {
  APP_SERVICES,
  DAEMON_SERVICES,
  FAKE_APP_SERVICES,
  FAKE_DAEMON_SERVICES,
} from '../../../../src/backend/container';
import { createContainer } from '../../../../src/backend/framework/dependency_injection';

describe('appUpdates', () => {
  it('has no HTTP update and refuses installation without loading fake or desktop services', async () => {
    const container = createContainer(null, [
      { identifier: 'appUpdates', require: () => appUpdatesDefinition },
    ]);

    expect(container.appUpdates.state).toBeNull();
    await expect(container.appUpdates.install()).rejects.toBeInstanceOf(AppUpdatesUnavailableError);
    await expect(container.appUpdates.install()).rejects.toMatchObject({
      code: 'UPDATES_UNAVAILABLE',
    });
    expect(container.listServiceInfos().map(service => service.identifier)).toEqual(['appUpdates']);
  });

  it('registers updates once per application and never in a daemon container', () => {
    expect(APP_SERVICES.filter(service => service.identifier === 'appUpdates')).toHaveLength(1);
    expect(FAKE_APP_SERVICES.filter(service => service.identifier === 'appUpdates')).toHaveLength(
      1
    );
    expect(DAEMON_SERVICES.map(service => service.identifier)).not.toContain('appUpdates');
    expect(FAKE_DAEMON_SERVICES.map(service => service.identifier)).not.toContain('appUpdates');
  });
});
