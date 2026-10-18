import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IFileLog } from '../../../../src/desktop/main/desktop_log';
import {
  type IPreferenceStore,
  createPreferenceStore,
} from '../../../../src/desktop/main/preferences';
import { createUpdateNotifications } from '../../../../src/desktop/main/update_notifications';
import type { IUpdateController } from '../../../../src/desktop/main/updates';
import type { IDesktopUpdateState } from '../../../../src/shared/desktop_bridge';

const READY: IDesktopUpdateState = {
  status: 'downloaded',
  currentVersion: '1.0.0',
  version: '1.1.0',
  installKind: 'appimage',
  percent: 100,
  disabledReason: null,
  error: null,
  requiresAuthorization: false,
};
let root: string;
let stores: IPreferenceStore[];

beforeEach(async () => {
  root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-update-notifications-'));
  stores = [];
});
afterEach(async () => {
  for (const store of stores) {
    store.flush();
  }
  await fs.rm(root, { recursive: true, force: true });
});

function setup() {
  const preferences = createPreferenceStore(root);
  stores.push(preferences);
  let state = READY;
  const listeners = new Set<(state: IDesktopUpdateState) => void>();
  const source: IUpdateController = {
    get state() {
      return state;
    },
    onState: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: vi.fn(),
    stop: vi.fn(),
    check: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
  };
  const updates = createUpdateNotifications({
    source,
    preferences,
    log: { info: vi.fn() } as unknown as IFileLog,
  });
  updates.start();
  const emit = (next: IDesktopUpdateState) => {
    state = next;
    for (const listener of listeners) {
      listener(next);
    }
  };
  return { updates, source, preferences, emit, listeners };
}

describe('update notification choices', () => {
  it('remembers a skipped version across restarts and keeps it through background checks', async () => {
    const first = setup();
    await first.updates.skip('1.1.0');
    first.preferences.flush();
    first.updates.stop();

    const restarted = setup();
    expect(restarted.updates.state.skippedVersion).toBe('1.1.0');
    restarted.emit({ ...READY, status: 'checking' });
    restarted.emit(READY);
    expect(restarted.updates.state).toMatchObject({
      status: 'downloaded',
      version: '1.1.0',
      skippedVersion: '1.1.0',
    });
    restarted.emit({ ...READY, version: '1.2.0' });
    expect(restarted.updates.state.version).not.toBe(restarted.updates.state.skippedVersion);
    restarted.updates.stop();
  });

  it('restores the notification immediately on a manual check and persists that choice', async () => {
    const { updates, source, preferences } = setup();
    await updates.skip('1.1.0');
    const listener = vi.fn();
    updates.onState(listener);
    await updates.check();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ skippedVersion: null }));
    expect(source.check).toHaveBeenCalledOnce();
    preferences.flush();
    expect(createPreferenceStore(root).ui()['pm2-captain-skipped-update-version']).toBe('');
    updates.stop();
  });

  it('ignores a stale skip and refuses to skip an active installation', async () => {
    const { updates, emit, preferences } = setup();
    emit({ ...READY, version: '1.2.0' });
    await updates.skip('1.1.0');
    emit({ ...READY, status: 'installing' });
    await updates.skip('1.1.0');
    expect(updates.state.skippedVersion).toBeNull();
    expect(preferences.ui()).toEqual({});
    updates.stop();
  });

  it('clears the skip before an explicit installation and releases source listeners on stop', async () => {
    const { updates, source, listeners, emit } = setup();
    await updates.skip('1.1.0');
    await updates.install();
    expect(updates.state.skippedVersion).toBeNull();
    expect(source.install).toHaveBeenCalledOnce();
    const listener = vi.fn();
    updates.onState(listener);
    updates.stop();
    expect(listeners.size).toBe(0);
    emit({ ...READY, version: '1.2.0' });
    expect(listener).not.toHaveBeenCalled();
    expect(source.stop).toHaveBeenCalledOnce();
  });
});
