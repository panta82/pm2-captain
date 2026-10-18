import { describe, expect, it, vi } from 'vitest';

import { createDesktopUpdatesAPI } from '../../../../src/frontend/lib/updates_api';
import type { IAppUpdateState, IDesktopBridge } from '../../../../src/shared/desktop_bridge';

const IDLE: IAppUpdateState = {
  status: 'idle',
  currentVersion: '1.0.0',
  installKind: 'appimage',
  version: null,
  percent: null,
  disabledReason: null,
  error: null,
  requiresAuthorization: false,
  skippedVersion: null,
};
const READY: IAppUpdateState = { ...IDLE, status: 'downloaded', version: '1.1.0' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(snapshot: Promise<IAppUpdateState>) {
  let listener!: (state: IAppUpdateState) => void;
  const removeListener = vi.fn();
  const bridge: IDesktopBridge['updates'] = {
    getState: vi.fn(() => snapshot),
    onState: vi.fn(onState => {
      listener = onState;
      return removeListener;
    }),
    check: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    skip: vi.fn(async (_version: string) => {}),
  };
  const api = createDesktopUpdatesAPI(bridge);
  const onState = vi.fn();
  const onError = vi.fn();
  const unsubscribe = api.subscribe(onState, onError);
  return { api, bridge, onState, onError, unsubscribe, removeListener, emit: listener };
}

describe('desktop updates API', () => {
  it('does not let a delayed snapshot overwrite a newer event', async () => {
    const snapshot = deferred<IAppUpdateState>();
    const { emit, onState, onError, unsubscribe } = setup(snapshot.promise);
    emit(READY);
    snapshot.resolve(IDLE);
    await snapshot.promise;

    expect(onState.mock.calls).toEqual([[READY]]);
    expect(onError).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('delivers the initial snapshot and each subsequent transition', async () => {
    const snapshot = Promise.resolve(IDLE);
    const { emit, onState, unsubscribe } = setup(snapshot);
    await snapshot;
    const installing: IAppUpdateState = { ...READY, status: 'installing' };
    const failed: IAppUpdateState = {
      ...READY,
      error: { phase: 'install', message: 'Installation failed.' },
    };
    emit(READY);
    emit(installing);
    emit(failed);

    expect(onState.mock.calls).toEqual([[IDLE], [READY], [installing], [failed]]);
    unsubscribe();
  });

  it('removes its listener and ignores queued events and replies after unsubscribe', async () => {
    const snapshot = deferred<IAppUpdateState>();
    const { emit, onState, onError, removeListener, unsubscribe } = setup(snapshot.promise);
    unsubscribe();
    unsubscribe();
    emit(READY);
    snapshot.resolve(IDLE);
    await snapshot.promise;

    expect(removeListener).toHaveBeenCalledOnce();
    expect(onState).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports snapshot errors, but ignores obsolete errors after a newer event', async () => {
    const snapshot = deferred<IAppUpdateState>();
    const first = setup(snapshot.promise);
    const error = new Error('IPC is unavailable.');
    snapshot.reject(error);
    await vi.waitFor(() => expect(first.onError).toHaveBeenCalledExactlyOnceWith(error));
    first.unsubscribe();

    const oldSnapshot = deferred<IAppUpdateState>();
    const second = setup(oldSnapshot.promise);
    second.emit(READY);
    oldSnapshot.reject(error);
    await oldSnapshot.promise.catch(() => undefined);
    await Promise.resolve();

    expect(second.onState).toHaveBeenCalledExactlyOnceWith(READY);
    expect(second.onError).not.toHaveBeenCalled();
    second.unsubscribe();
  });

  it('preserves rejected installation requests for the caller to handle', async () => {
    const { api, bridge, unsubscribe } = setup(Promise.resolve(IDLE));
    const error = new Error('IPC request was refused.');
    vi.mocked(bridge.install).mockRejectedValueOnce(error);

    await expect(api.install()).rejects.toBe(error);
    expect(bridge.install).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('sends the exact version to skip through the trusted bridge', async () => {
    const { api, bridge, unsubscribe } = setup(Promise.resolve(READY));
    await api.skip('1.1.0');
    expect(bridge.skip).toHaveBeenCalledExactlyOnceWith('1.1.0');
    unsubscribe();
  });
});
