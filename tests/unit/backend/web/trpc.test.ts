import { describe, expect, it } from 'vitest';

import { isRequestOriginAllowed } from '../../../../src/backend/web/trpc';

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

describe('error logging', () => {
  it('keeps SSH option values out of the log, also when an error quotes them', async () => {
    const { fetchRequestHandler } = await import('@trpc/server/adapters/fetch');
    const { createAppRouter } = await import('../../../../src/backend/web/app_router');
    const { InvalidDaemonError } = await import('../../../../src/backend/bl/daemon_manager');
    const SECRET = 'SENTINEL-proxy-password-1f9a';
    const logged: unknown[] = [];
    const log = { error: (...args: unknown[]) => void logged.push(args) };
    const container = {
      settings: { runtime: 'cli' },
      daemonManager: {
        update: async () => {
          // A failure that echoes its input, as SSH does with a bad option.
          throw Object.assign(new InvalidDaemonError(`Bad SSH option: -o ProxyCommand=${SECRET}`), {
            cause: new Error(`ssh: ${SECRET}`),
          });
        },
      },
    };
    const daemon = {
      kind: 'ssh',
      sshArgs: ['-o', `ProxyCommand=${SECRET}`, 'deploy@example.com'],
    };

    const response = await fetchRequestHandler({
      endpoint: '/api/trpc',
      req: new Request('http://127.0.0.1:3212/api/trpc/daemons.update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          daemonId: '830f902f-c88b-4ed8-8051-c3a81c44ed87',
          daemon,
          expected: daemon,
        }),
      }),
      router: createAppRouter(container as never),
      createContext: () =>
        ({ container, isAuthenticated: true, isOriginAllowed: true, log }) as never,
    });

    expect(response.status).toBe(400);
    expect(logged).toHaveLength(1);
    const text = JSON.stringify(logged);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('daemons.update');
    expect(text).toContain('INVALID_DAEMON');
  });
});
