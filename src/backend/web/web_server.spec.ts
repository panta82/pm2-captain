import { describe, expect, it } from 'vitest';

import { isBackendRequestPath } from './web_server';

describe('development request routing', () => {
  it.each(['/health', '/launch', '/api/trpc/processes.list'])(
    'keeps %s out of Vite SPA middleware',
    path => {
      expect(isBackendRequestPath(path)).toBe(true);
    }
  );

  it.each(['/', '/processes/0/info', '/does-not-exist', '/@vite/client'])(
    'allows Vite to serve %s',
    path => {
      expect(isBackendRequestPath(path)).toBe(false);
    }
  );
});
