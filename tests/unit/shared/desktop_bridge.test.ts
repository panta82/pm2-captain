import { describe, expect, it } from 'vitest';

import {
  DESKTOP_PREFERENCE_KEYS,
  type IDesktopPreferenceKey,
  isDesktopPreferenceKey,
  isValidDesktopPreference,
} from '../../../src/shared/desktop_bridge';

const DAEMON_ID = '830f902f-c88b-4ed8-8051-c3a81c44ed87';

/** The preferences that hold a JSON list, with one item of each. */
const LIST_ITEMS: Array<[IDesktopPreferenceKey, string]> = [
  ['pm2-captain-collapsed-daemons', DAEMON_ID],
  ['pm2-captain-collapsed-namespaces', `namespace:${DAEMON_ID}:web`],
  ['pm2-captain-pinned-processes', `process:${DAEMON_ID}:12`],
];

const list = (...items: unknown[]) => JSON.stringify(items);

/** What the renderer writes for each preference, and what it never does. */
const CASES: Record<IDesktopPreferenceKey, { valid: string[]; invalid: unknown[] }> = {
  'pm2-captain-collapsed-daemons': {
    valid: [list(DAEMON_ID, DAEMON_ID.toUpperCase())],
    invalid: [list('../../etc'), list(`daemon:${DAEMON_ID}`)],
  },
  'pm2-captain-collapsed-namespaces': {
    // A namespace's name is PM2's to choose, and may hold a colon or a space.
    valid: [list(`namespace:${DAEMON_ID}:with colon`, `namespace:${DAEMON_ID}:a space`)],
    invalid: [
      list(`namespace:${DAEMON_ID}:`),
      list(`namespace:${DAEMON_ID}:new\nline`),
      list(`process:${DAEMON_ID}:12`),
    ],
  },
  'pm2-captain-pinned-processes': {
    valid: [list(`process:${DAEMON_ID}:0`, `process:${DAEMON_ID}:1234567890`)],
    invalid: [
      list(`process:${DAEMON_ID}:`),
      list(`process:${DAEMON_ID}:12a`),
      list(`process:${DAEMON_ID}:12345678901`),
      list(`namespace:${DAEMON_ID}:web`),
    ],
  },
  'pm2-captain-process-sort': {
    valid: ['', 'cpu:desc', 'name:asc'],
    invalid: ['../../etc', 'cpu', 'cpu:up', `${'a'.repeat(21)}:asc`],
  },
  'pm2-captain-process-tab': {
    valid: ['info', 'env', 'logs'],
    invalid: ['', 'settings'],
  },
  'pm2-captain:process-sidebar-width': {
    valid: ['320', '1600'],
    invalid: [320, '', '-1', '12345'],
  },
  'pm2-captain-matrix-only-differences': {
    valid: ['true', 'false'],
    invalid: [true, 'yes'],
  },
  'pm2-captain-skipped-update-version': {
    valid: ['', '1.2.3-beta.1', '1'.repeat(200)],
    invalid: ['../../etc', '-1.0.0', '1'.repeat(201)],
  },
};

describe('isDesktopPreferenceKey', () => {
  it('knows the preferences, and nothing else a page could send', () => {
    expect(DESKTOP_PREFERENCE_KEYS.filter(isDesktopPreferenceKey)).toEqual(DESKTOP_PREFERENCE_KEYS);
    for (const key of ['launch-token', 'toString', '__proto__', '', 1, null, undefined]) {
      expect(isDesktopPreferenceKey(key)).toBe(false);
    }
  });
});

describe('isValidDesktopPreference', () => {
  it.each(DESKTOP_PREFERENCE_KEYS)('accepts only what the renderer writes for %s', key => {
    const { valid, invalid } = CASES[key];
    for (const value of valid) {
      expect(isValidDesktopPreference(key, value), value).toBe(true);
    }
    for (const value of [...invalid, undefined, null]) {
      expect(isValidDesktopPreference(key, value), String(value)).toBe(false);
    }
  });

  it.each(LIST_ITEMS)(
    'takes %s only as a JSON list of strings, short enough to keep',
    (key, item) => {
      expect(isValidDesktopPreference(key, '[]')).toBe(true);
      expect(isValidDesktopPreference(key, list(...Array(300).fill(item)))).toBe(true);
      for (const value of ['', '{broken', '{}', JSON.stringify(item), list(1), list(null)]) {
        expect(isValidDesktopPreference(key, value), value).toBe(false);
      }
      // A list grows with the daemons, namespaces or pins, but only so far.
      expect(isValidDesktopPreference(key, list(...Array(600).fill(item)))).toBe(false);
    }
  );
});
