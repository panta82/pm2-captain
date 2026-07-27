import { describe, expect, it } from 'vitest';

import { isRequestOriginAllowed } from './trpc';

describe('request origin validation', () => {
  it('uses the internal URL while Captain authentication is enabled', () => {
    expect(
      isRequestOriginAllowed(
        { origin: 'https://captain.example.com', host: 'captain.example.com' },
        'http://127.0.0.1:3212',
        false
      )
    ).toBe(false);
  });

  it('accepts the observed same origin behind a proxy when authentication is disabled', () => {
    expect(
      isRequestOriginAllowed(
        {
          origin: 'https://captain.example.com',
          host: 'captain.example.com',
          'x-forwarded-proto': 'https',
        },
        'http://127.0.0.1:3212',
        true
      )
    ).toBe(true);
  });

  it('still rejects cross-origin requests when authentication is disabled', () => {
    expect(
      isRequestOriginAllowed(
        {
          origin: 'https://attacker.example.com',
          host: 'captain.example.com',
          'x-forwarded-proto': 'https',
        },
        'http://127.0.0.1:3212',
        true
      )
    ).toBe(false);
  });
});
