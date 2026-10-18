import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { describe, expect, it, vi } from 'vitest';

import { createAppUpdates } from '../../../../src/backend/bl/app_updates';
import { createAppUpdates as createFakeAppUpdates } from '../../../../src/backend/fake/fake_app_updates';
import { createFakeUpdates } from '../../../../src/backend/fake/fake_updates';
import { createAppRouter } from '../../../../src/backend/web/app_router';
import type { IAppUpdateState } from '../../../../src/shared/desktop_bridge';

function setup(isAuthenticated = true, isOriginAllowed = true) {
  const fakeUpdates = createFakeUpdates('1.0.0');
  const appUpdates = createFakeAppUpdates({ fakeWorld: { updates: fakeUpdates } } as never);
  const container = { settings: { runtime: 'cli' }, appUpdates };
  const context = {
    container,
    isAuthenticated,
    isOriginAllowed,
    log: { error: vi.fn() },
  };
  const router = createAppRouter(container as never);
  const caller = router.createCaller(context as never);
  return { fakeUpdates, appUpdates, container, context, router, caller };
}

describe('updates API', () => {
  it('streams the current state, every immediate install transition and resets, then unsubscribes', async () => {
    const { fakeUpdates, caller, appUpdates } = setup();
    const watch = appUpdates.onChange;
    const stopWatching = vi.fn();
    const onChange = vi.spyOn(appUpdates, 'onChange').mockImplementation(listener => {
      const unsubscribe = watch(listener);
      return () => {
        stopWatching();
        unsubscribe();
      };
    });
    const stream = await caller.updates.state();
    const states: (IAppUpdateState | null)[] = [];
    const subscription = stream.subscribe({ next: state => states.push(state) });
    expect(states.map(state => state?.status)).toEqual(['idle']);

    fakeUpdates.set({ status: 'downloaded', version: '1.1.0' });
    await caller.updates.install();

    expect(states.map(state => state?.status)).toEqual([
      'idle',
      'downloaded',
      'installing',
      'downloaded',
    ]);
    expect(states.at(-1)?.error?.phase).toBe('install');
    fakeUpdates.reset();
    expect(states.at(-1)).toMatchObject({ status: 'idle', version: null });
    expect(onChange).toHaveBeenCalledOnce();

    subscription.unsubscribe();
    expect(stopWatching).toHaveBeenCalledOnce();
    fakeUpdates.set({ status: 'downloaded', version: '1.2.0' });
    expect(states).toHaveLength(5);
  });

  it('emits null and completes for an ordinary backend without registering a listener', async () => {
    const appUpdates = createAppUpdates({} as never);
    const onChange = vi.spyOn(appUpdates, 'onChange');
    const container = { settings: { runtime: 'desktop' }, appUpdates };
    const caller = createAppRouter(container as never).createCaller({
      isAuthenticated: true,
      isOriginAllowed: true,
    } as never);
    const stream = await caller.updates.state();
    const next = vi.fn();
    const complete = vi.fn();

    stream.subscribe({ next, complete });

    expect(next).toHaveBeenCalledExactlyOnceWith(null);
    expect(complete).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a typed unavailable installation through the HTTP error contract', async () => {
    const { container, context, router } = setup();
    container.appUpdates = createAppUpdates({} as never);
    const response = await fetchRequestHandler({
      endpoint: '/api/trpc',
      req: new Request('http://127.0.0.1:3212/api/trpc/updates.install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
      router,
      createContext: () => context as never,
    });

    expect(response.status).toBe(412);
    expect(await response.json()).toMatchObject({
      error: { data: { code: 'PRECONDITION_FAILED', appCode: 'UPDATES_UNAVAILABLE' } },
    });
    const caller = router.createCaller(context as never);
    await expect(caller.updates.skip({ version: '1.1.0' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('skips only the current download and validates the version before invoking the service', async () => {
    const { caller, fakeUpdates, appUpdates } = setup();
    fakeUpdates.set({ status: 'downloaded', version: '1.1.0' });
    await caller.updates.skip({ version: '1.0.1' });
    expect(appUpdates.state?.skippedVersion).toBeNull();
    await caller.updates.skip({ version: '1.1.0' });
    expect(appUpdates.state?.skippedVersion).toBe('1.1.0');
    const skip = vi.spyOn(appUpdates, 'skip');
    await expect(caller.updates.skip({ version: '' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.updates.skip({ version: 'x'.repeat(201) })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(skip).not.toHaveBeenCalled();
  });

  it.each([
    { isAuthenticated: false, isOriginAllowed: true, code: 'UNAUTHORIZED' },
    { isAuthenticated: true, isOriginAllowed: false, code: 'FORBIDDEN' },
  ])(
    'protects the state stream, installation and skipping with $code',
    async ({ isAuthenticated, isOriginAllowed, code }) => {
      const { caller, appUpdates } = setup(isAuthenticated, isOriginAllowed);
      const install = vi.spyOn(appUpdates, 'install');
      const onChange = vi.spyOn(appUpdates, 'onChange');
      const skip = vi.spyOn(appUpdates, 'skip');

      await expect(caller.updates.state()).rejects.toMatchObject({ code });
      await expect(caller.updates.install()).rejects.toMatchObject({ code });
      await expect(caller.updates.skip({ version: '1.1.0' })).rejects.toMatchObject({ code });

      expect(install).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(skip).not.toHaveBeenCalled();
    }
  );
});
