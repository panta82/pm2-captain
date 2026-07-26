import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const bus = {
    on(event: string, listener: (...args: any[]) => void) {
      const eventListeners = listeners.get(event) || new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return bus;
    },
    emit(event: string, ...args: any[]) {
      for (const listener of listeners.get(event) || []) {
        listener(...args);
      }
    },
    removeAllListeners() {
      listeners.clear();
    },
  };
  return {
    bus,
    pm2: {
      connect: vi.fn((callback: (error: Error | null) => void) => callback(null)),
      launchBus: vi.fn(
        (callback: (error: Error | null, bus: any) => void) =>
          callback(null, bus)
      ),
      disconnect: vi.fn(),
      list: vi.fn(),
      describe: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
    },
  };
});

vi.mock('pm2', () => ({ default: mocked.pm2 }));

import { createPm2Client } from './pm2_client';

function createClient() {
  return createPm2Client({
    log: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as never);
}

describe('pm2Client', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocked.bus.removeAllListeners();
    mocked.pm2.connect.mockImplementation(callback => callback(null));
    mocked.pm2.launchBus.mockImplementation(callback =>
      callback(null, mocked.bus)
    );
  });

  it('forwards exact PM2 stdout and stderr bus events', async () => {
    const client = createClient();
    const listener = vi.fn();
    client.onLog(listener);
    await client.initialize();
    await client.start();

    const packet = {
      data: 'captain',
      process: { name: 'fixture', pm_id: 7 },
    };
    mocked.bus.emit('log:out', packet);
    mocked.bus.emit('log:err', packet);

    expect(listener).toHaveBeenNthCalledWith(1, { type: 'out', packet });
    expect(listener).toHaveBeenNthCalledWith(2, { type: 'err', packet });
    await client.stop();
    await client.dispose();
    expect(mocked.pm2.disconnect).toHaveBeenCalledOnce();
  });

  it('times out callback operations that never settle', async () => {
    vi.useFakeTimers();
    mocked.pm2.list.mockImplementation(() => undefined);
    const client = createClient();

    const pending = expect(client.list()).rejects.toThrow('PM2 list timed out');
    await vi.advanceTimersByTimeAsync(10_000);

    await pending;
  });

  it('reattaches the event bus after it closes', async () => {
    vi.useFakeTimers();
    const client = createClient();
    const statuses: boolean[] = [];
    client.onDaemonStatus(connected => statuses.push(connected));
    await client.initialize();
    await client.start();

    mocked.bus.emit('close');
    await vi.advanceTimersByTimeAsync(500);

    expect(mocked.pm2.launchBus).toHaveBeenCalledTimes(2);
    expect(mocked.pm2.connect).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([true, false, true]);
    await client.stop();
    await client.dispose();
  });

  it('cancels pending reconnect work during shutdown', async () => {
    vi.useFakeTimers();
    const client = createClient();
    await client.initialize();
    await client.start();
    mocked.bus.emit('close');

    await client.stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocked.pm2.launchBus).toHaveBeenCalledOnce();
    await client.dispose();
  });
});
