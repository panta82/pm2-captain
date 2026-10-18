// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { type ReactNode, createElement, isValidElement } from 'react';
import type { ExternalToast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdateNotice } from '../../../../src/frontend/components/update_notice';
import { type IUpdatesAPI, UpdatesAPIProvider } from '../../../../src/frontend/lib/updates_api';
import type { IAppUpdateState } from '../../../../src/shared/desktop_bridge';

const notifications = vi.hoisted(() => ({
  message: vi.fn<(content: ReactNode, options?: ExternalToast) => string | number>(),
  error: vi.fn<(content: ReactNode, options?: ExternalToast) => string | number>(),
  dismiss: vi.fn<(id?: string | number) => void>(),
}));
vi.mock('sonner', () => ({ toast: notifications }));

const READY: IAppUpdateState = {
  status: 'downloaded',
  currentVersion: '1.0.0',
  installKind: 'appimage',
  version: '1.1.0',
  percent: 100,
  disabledReason: null,
  error: null,
  requiresAuthorization: false,
  skippedVersion: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  let nextId = 1;
  notifications.message.mockImplementation((_content, options) => options?.id ?? nextId++);
  notifications.error.mockImplementation((_content, options) => options?.id ?? nextId++);
});
afterEach(cleanup);

function setup() {
  let emit!: (state: IAppUpdateState | null) => void;
  let fail!: (error: Error) => void;
  const unsubscribe = vi.fn();
  const api: IUpdatesAPI = {
    subscribe: (_onState, _onError) => {
      emit = _onState;
      fail = _onError;
      return unsubscribe;
    },
    install: vi.fn(async () => {}),
    skip: vi.fn(async (_version: string) => {}),
  };
  const view = render(createElement(UpdatesAPIProvider, { api }, createElement(UpdateNotice)));
  return { api, emit, fail, unsubscribe, view };
}

function lastToast() {
  const call = notifications.message.mock.calls.at(-1);
  if (
    !call ||
    !isValidElement<{ state: IAppUpdateState; onInstall: () => void; onSkip: () => void }>(call[0])
  ) {
    throw new Error('Expected an update toast.');
  }
  return {
    ...call[0].props,
    options: call[1],
    id: notifications.message.mock.results.at(-1)?.value,
  };
}

describe('update notifications', () => {
  it('skips the displayed version through the API and hides replayed skipped states', async () => {
    const { api, emit } = setup();
    emit(READY);
    const id = lastToast().id;
    lastToast().onSkip();
    await vi.waitFor(() => expect(api.skip).toHaveBeenCalledExactlyOnceWith('1.1.0'));
    const skipped: IAppUpdateState = { ...READY, skippedVersion: '1.1.0' };
    emit(skipped);
    emit(structuredClone(skipped));
    expect(notifications.dismiss).toHaveBeenCalledWith(id);
    expect(notifications.message).toHaveBeenCalledOnce();

    emit({ ...skipped, version: '1.2.0' });
    expect(lastToast().state.version).toBe('1.2.0');
    expect(notifications.message).toHaveBeenCalledTimes(2);
  });

  it('handles immediate install events and resurfaces repeated identical failures after a skip', () => {
    const { emit } = setup();
    const failed: IAppUpdateState = {
      ...READY,
      error: { phase: 'install', message: 'The installation failed.' },
    };
    emit(READY);
    emit({ ...READY, skippedVersion: '1.1.0' });
    expect(notifications.message).toHaveBeenCalledTimes(1);

    // Each sequence is synchronous, so React can batch all of its rendering.
    emit({ ...READY, status: 'installing' });
    emit(failed);
    expect(lastToast().state).toEqual(failed);
    expect(notifications.message).toHaveBeenCalledTimes(3);

    emit({ ...failed, skippedVersion: '1.1.0' });
    emit({ ...READY, status: 'installing' });
    emit(failed);
    expect(lastToast().state).toEqual(failed);
    expect(notifications.message).toHaveBeenCalledTimes(5);
  });

  it('keeps the toast available and reports a rejected skip request', async () => {
    const { api, emit } = setup();
    vi.mocked(api.skip).mockRejectedValueOnce(new Error('IPC request was refused.'));
    emit(READY);
    lastToast().onSkip();
    await vi.waitFor(() => {
      expect(notifications.message).toHaveBeenCalledOnce();
      expect(notifications.error).toHaveBeenCalledWith('Unable to skip this version.', {
        description: 'IPC request was refused.',
      });
    });
  });

  it('catches installation rejection and leaves the update available to retry', async () => {
    const { api, emit } = setup();
    vi.mocked(api.install).mockRejectedValueOnce(new Error('IPC installation was refused.'));
    emit(READY);
    lastToast().onInstall();

    await vi.waitFor(() => {
      expect(lastToast().state).toMatchObject({
        status: 'downloaded',
        version: '1.1.0',
        error: { phase: 'install', message: 'IPC installation was refused.' },
      });
    });
    expect(api.install).toHaveBeenCalledOnce();
  });

  it('releases its subscription and ignores late events and install failures after unmount', async () => {
    const { api, emit, unsubscribe, view } = setup();
    let rejectInstall!: (error: Error) => void;
    vi.mocked(api.install).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectInstall = reject;
        })
    );
    emit(READY);
    const id = lastToast().id;
    const installUpdate = lastToast().onInstall;
    installUpdate();
    await vi.waitFor(() => expect(api.install).toHaveBeenCalledOnce());
    view.unmount();
    emit({ ...READY, version: '1.2.0' });
    rejectInstall(new Error('The window closed.'));
    await Promise.resolve();
    await Promise.resolve();
    installUpdate();
    await Promise.resolve();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(notifications.dismiss).toHaveBeenCalledWith(id);
    expect(notifications.message).toHaveBeenCalledOnce();
    expect(notifications.error).not.toHaveBeenCalled();
    expect(api.install).toHaveBeenCalledOnce();
  });

  it('uses a fresh notification after a stream error toast has closed', () => {
    const { fail, emit } = setup();
    fail(new Error('The connection dropped.'));
    const options = notifications.error.mock.calls.at(-1)?.[1];
    const result = notifications.error.mock.results.at(-1);
    expect(result?.type).toBe('return');
    options?.onAutoClose?.({ id: result?.value });

    fail(new Error('Still disconnected.'));
    expect(notifications.error.mock.calls.at(-1)?.[1]?.id).toBeUndefined();
    const nextId = notifications.error.mock.results.at(-1)?.value;
    emit(READY);
    expect(notifications.dismiss).toHaveBeenCalledWith(nextId);
  });
});
