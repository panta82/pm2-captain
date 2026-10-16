import { describe, expect, it } from 'vitest';

import { isBackendMessage } from '../../../../src/desktop/shared/backend_protocol';

const TOKEN = 'a'.repeat(43);

describe('backend protocol', () => {
  it('accepts a ready message only for a loopback origin and a real token', () => {
    const ready = {
      type: 'ready',
      runId: 'r',
      baseURL: 'http://127.0.0.1:45713',
      launchToken: TOKEN,
    };
    expect(isBackendMessage(ready)).toBe(true);
    for (const baseURL of [
      'http://127.0.0.1:0',
      'http://localhost:45713',
      'https://127.0.0.1:45713',
      'http://127.0.0.1:45713/x',
      'http://0.0.0.0:45713',
    ]) {
      expect(isBackendMessage({ ...ready, baseURL })).toBe(false);
    }
    expect(isBackendMessage({ ...ready, launchToken: 'short' })).toBe(false);
  });

  it('validates the other messages', () => {
    expect(isBackendMessage({ type: 'owned-processes', pids: [123, 456] })).toBe(true);
    expect(isBackendMessage({ type: 'owned-processes', pids: [1] })).toBe(false);
    expect(isBackendMessage({ type: 'owned-processes', pids: ['123'] })).toBe(false);
    expect(isBackendMessage({ type: 'failed', runId: 'r', error: { message: 'x' } })).toBe(true);
    expect(isBackendMessage({ type: 'stopped', runId: 'r' })).toBe(true);
    expect(isBackendMessage({ type: 'stopped' })).toBe(false);
    expect(isBackendMessage(null)).toBe(false);
  });

  it('accepts a simulated update state only in the shape the bridge expects', () => {
    const state = {
      status: 'downloaded',
      currentVersion: '1.5.0',
      installKind: 'deb',
      version: '9.9.9',
      percent: 100,
      disabledReason: null,
      error: null,
      requiresAuthorization: true,
    };
    expect(isBackendMessage({ type: 'fake-update', state })).toBe(true);
    expect(isBackendMessage({ type: 'fake-update', state: { ...state, status: 'exploded' } })).toBe(
      false
    );
    expect(isBackendMessage({ type: 'fake-update', state: null })).toBe(false);
  });
});
