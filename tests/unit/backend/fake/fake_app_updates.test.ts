import { describe, expect, it, vi } from 'vitest';

import fakeAppUpdatesDefinition from '../../../../src/backend/fake/fake_app_updates';
import { createFakeWorld } from '../../../../src/backend/fake/fake_world';
import { createContainer, define } from '../../../../src/backend/framework/dependency_injection';
import type { IAppUpdateState } from '../../../../src/shared/desktop_bridge';

describe('fake appUpdates', () => {
  it('uses the injected world for actions and reset, and releases its change listener', async () => {
    const fakeWorld = createFakeWorld({
      settings: { fake: { scenario: 'basic' } },
      log: { info: vi.fn() },
    } as never);
    const container = createContainer(null, [
      { identifier: 'appUpdates', require: () => fakeAppUpdatesDefinition },
      { identifier: 'fakeWorld', require: () => define({ createFakeWorld: () => fakeWorld }) },
    ]);
    const updates = container.appUpdates;
    const states: (IAppUpdateState | null)[] = [];
    const unsubscribe = updates.onChange(state => states.push(state));

    fakeWorld.apply({ type: 'update.set', status: 'downloaded', version: '9.9.9' });
    await updates.install();

    expect(updates.state).toBe(fakeWorld.updates.state);
    expect(states.map(state => state?.status)).toEqual(['downloaded', 'installing', 'downloaded']);
    expect(states.at(-1)?.error).toMatchObject({ phase: 'install' });

    await fakeWorld.reset({ daemons: [] });
    expect(states.at(-1)).toMatchObject({ status: 'idle', version: null });

    unsubscribe();
    unsubscribe();
    const seenBeforeUnsubscribe = states.length;
    fakeWorld.apply({ type: 'update.set', status: 'downloaded', version: '9.9.10' });
    expect(states).toHaveLength(seenBeforeUnsubscribe);
    expect(updates.state?.version).toBe('9.9.10');
  });
});
