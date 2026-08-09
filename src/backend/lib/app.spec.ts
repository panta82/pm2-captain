import { describe, expect, it, vi } from 'vitest';

import { createApp } from './app';

function setup(services: Record<string, object>) {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    isLevelEnabled: vi.fn(() => false),
  };
  const container = {
    identifiers: Object.keys(services),
    ...services,
  };
  return { app: createApp({ container, log } as never), log };
}

describe('app lifecycle rollback', () => {
  it('disposes invoked initialization services in reverse order', async () => {
    const calls: string[] = [];
    const failure = new Error('initialization failed');
    const failingInitialize = vi.fn<() => Promise<void>>(async () => {
      calls.push('initialize:failure');
      throw failure;
    });
    const { app } = setup({
      first: {
        initialize: vi.fn(() => calls.push('initialize:first')),
        dispose: vi.fn(() => calls.push('dispose:first')),
      },
      second: {
        initialize: vi.fn(() => calls.push('initialize:second')),
        dispose: vi.fn(() => calls.push('dispose:second')),
      },
      failure: {
        initialize: failingInitialize,
        dispose: vi.fn(() => calls.push('dispose:failure')),
      },
    });

    await expect(app.initialize()).rejects.toBe(failure);
    expect(calls).toEqual([
      'initialize:first',
      'initialize:second',
      'initialize:failure',
      'dispose:failure',
      'dispose:second',
      'dispose:first',
    ]);
    expect(app.state.stage).toBe('idle');

    failingInitialize.mockImplementationOnce(async () => undefined);
    await expect(app.initialize()).resolves.toBe(true);
    expect(app.state.stage).toBe('ready');
  });

  it('stops invoked startup services and leaves the app ready to retry', async () => {
    const calls: string[] = [];
    const failure = new Error('start failed');
    const failingStart = vi.fn<() => Promise<void>>(async () => {
      calls.push('start:failure');
      throw failure;
    });
    const { app } = setup({
      first: {
        start: vi.fn(() => calls.push('start:first')),
        stop: vi.fn(() => calls.push('stop:first')),
      },
      second: {
        start: vi.fn(() => calls.push('start:second')),
        stop: vi.fn(() => calls.push('stop:second')),
      },
      failure: {
        start: failingStart,
        stop: vi.fn(() => calls.push('stop:failure')),
      },
    });

    await expect(app.start()).rejects.toBe(failure);
    expect(calls).toEqual([
      'start:first',
      'start:second',
      'start:failure',
      'stop:failure',
      'stop:second',
      'stop:first',
    ]);
    expect(app.state.stage).toBe('ready');

    failingStart.mockImplementationOnce(async () => undefined);
    await expect(app.start()).resolves.toBe(true);
    expect(app.state.stage).toBe('active');
  });

  it('logs downward failures and continues through disposal', async () => {
    const calls: string[] = [];
    const secondError = new Error('second stop failed');
    const thirdError = new Error('third stop failed');
    const { app, log } = setup({
      first: {
        start: vi.fn(),
        stop: vi.fn(() => calls.push('stop:first')),
        dispose: vi.fn(() => calls.push('dispose:first')),
      },
      second: {
        start: vi.fn(),
        stop: vi.fn(() => {
          calls.push('stop:second');
          throw secondError;
        }),
        dispose: vi.fn(() => calls.push('dispose:second')),
      },
      third: {
        start: vi.fn(),
        stop: vi.fn(() => {
          calls.push('stop:third');
          throw thirdError;
        }),
        dispose: vi.fn(() => calls.push('dispose:third')),
      },
    });
    log.error.mockImplementation(({ error }: { error: Error }) => {
      calls.push(`log:${error.message}`);
    });
    await app.start();

    await expect(app.dispose()).resolves.toBeUndefined();
    expect(calls).toEqual([
      'stop:third',
      'log:third stop failed',
      'stop:second',
      'log:second stop failed',
      'stop:first',
      'dispose:third',
      'dispose:second',
      'dispose:first',
    ]);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(app.state.stage).toBe('idle');
  });

  it('logs rollback failures and preserves the forward error', async () => {
    const forwardError = new Error('start failed');
    const rollbackError = new Error('stop failed');
    const { app, log } = setup({
      first: {
        start: vi.fn(),
        stop: vi.fn(() => {
          throw rollbackError;
        }),
      },
      failure: {
        start: vi.fn(() => {
          throw forwardError;
        }),
      },
    });

    await expect(app.start()).rejects.toBe(forwardError);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: rollbackError }),
      'Rollback lifecycle method first.stop() failed'
    );
  });

  it('rejects suspended waiters and rolls back every invoked service', async () => {
    const failure = new Error('initialization failed');
    const calls: string[] = [];
    const { app } = setup({
      waiter: {
        initialize: vi.fn(async (waitFor: (identifier: string) => Promise<void>) => {
          calls.push('initialize:waiter');
          try {
            await waitFor('dependency');
          } finally {
            calls.push('initialize:waiter:rejected');
          }
        }),
        dispose: vi.fn(() => calls.push('dispose:waiter')),
      },
      failure: {
        initialize: vi.fn(() => {
          calls.push('initialize:failure');
          throw failure;
        }),
        dispose: vi.fn(() => calls.push('dispose:failure')),
      },
      dependency: {
        initialize: vi.fn(() => calls.push('initialize:dependency')),
        dispose: vi.fn(() => calls.push('dispose:dependency')),
      },
    });

    await expect(app.initialize()).rejects.toBe(failure);
    expect(calls).toEqual([
      'initialize:waiter',
      'initialize:failure',
      'initialize:waiter:rejected',
      'dispose:failure',
      'dispose:waiter',
    ]);
  });

  it('rejects waits for unknown services', async () => {
    const { app } = setup({
      waiter: {
        initialize: vi.fn(async (waitFor: (identifier: string) => Promise<void>) => {
          await waitFor('missing');
        }),
      },
    });

    await expect(app.initialize()).rejects.toThrow(
      'Service waiter cannot wait for unknown service missing'
    );
  });
});
