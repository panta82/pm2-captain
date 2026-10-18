import { describe, expect, it, vi } from 'vitest';

import { InvalidFakeCommandError } from '../../../../src/backend/fake/fake_commands';
import { createFakeUpdates } from '../../../../src/backend/fake/fake_updates';

describe('fake updates', () => {
  it('starts idle with the running version', () => {
    expect(createFakeUpdates('1.5.0').state).toMatchObject({
      status: 'idle',
      currentVersion: '1.5.0',
      version: null,
      error: null,
      requiresAuthorization: false,
    });
  });

  it('takes the states the real updater reports, and asks for a password on DEB and RPM', () => {
    const updates = createFakeUpdates('1.5.0');

    updates.set({ status: 'downloading', version: '1.6.0', percent: 42 });
    expect(updates.state).toMatchObject({ status: 'downloading', version: '1.6.0', percent: 42 });
    updates.set({ status: 'downloaded', version: '1.6.0', installKind: 'deb' });
    expect(updates.state).toMatchObject({ percent: 100, requiresAuthorization: true });
    updates.set({ status: 'error', errorPhase: 'check', errorMessage: 'offline' });
    expect(updates.state).toMatchObject({
      status: 'error',
      error: { phase: 'check', message: 'offline' },
      installKind: 'deb',
    });
  });

  it('refuses states the real updater cannot be in', () => {
    const updates = createFakeUpdates('1.5.0');

    expect(() => updates.set({ status: 'downloaded' })).toThrow(InvalidFakeCommandError);
    expect(() => updates.set({ status: 'error', errorPhase: 'check' })).toThrow(
      InvalidFakeCommandError
    );
    expect(updates.state.status).toBe('idle');
  });

  it('fails a simulated installation by default, and can keep it installing', () => {
    const updates = createFakeUpdates('1.5.0');
    const seen: string[] = [];
    updates.onChange(state => seen.push(state.status));
    updates.set({ status: 'downloaded', version: '1.6.0' });

    updates.install();
    expect(updates.state).toMatchObject({
      status: 'downloaded',
      error: { phase: 'install', message: 'The simulated installation failed.' },
    });
    expect(seen).toEqual(['downloaded', 'installing', 'downloaded']);

    updates.setInstallOutcome({ outcome: 'stay' });
    updates.install();
    expect(updates.state).toMatchObject({ status: 'installing', error: null });
  });

  it('installs only a downloaded update, and counts checks without changing state', () => {
    const updates = createFakeUpdates('1.5.0');
    const listener = vi.fn();
    updates.onChange(listener);

    updates.install();
    updates.check();
    updates.check();

    expect(listener).not.toHaveBeenCalled();
    expect(updates.snapshot()).toMatchObject({ status: 'idle', checkCount: 2 });
  });

  it('starts over on reset', () => {
    const updates = createFakeUpdates('1.5.0');
    updates.set({ status: 'downloaded', version: '1.6.0', installKind: 'rpm' });
    updates.setInstallOutcome({ outcome: 'stay', message: 'x' });
    updates.check();

    updates.reset();

    expect(updates.snapshot()).toMatchObject({
      status: 'idle',
      version: null,
      installKind: 'appimage',
      checkCount: 0,
      installOutcome: { outcome: 'fail', message: 'The simulated installation failed.' },
    });
  });

  it('keeps a skipped version through state changes until a manual check or installation', () => {
    const updates = createFakeUpdates('1.0.0');
    updates.set({ status: 'downloaded', version: '1.1.0' });
    updates.skip('1.0.1');
    expect(updates.state.skippedVersion).toBeNull();
    updates.skip('1.1.0');
    updates.set({ status: 'downloaded', version: '1.1.0' });
    expect(updates.state.skippedVersion).toBe('1.1.0');
    updates.set({ status: 'downloaded', version: '1.2.0' });
    expect(updates.state.version).not.toBe(updates.state.skippedVersion);
    updates.skip('1.2.0');
    updates.check();
    expect(updates.state.skippedVersion).toBeNull();
    updates.skip('1.2.0');
    updates.install();
    expect(updates.state.skippedVersion).toBeNull();
  });
});
