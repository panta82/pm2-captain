import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Pm2DaemonUnavailableError, createPm2Client } from '../../../../src/backend/lib/pm2_client';

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
  const api = {
    Client: {
      launchRPC: vi.fn((callback: (error: Error | null) => void) => callback(null)),
      pingDaemon: vi.fn((callback: (isAlive: boolean) => void) => callback(true)),
    },
    launchBus: vi.fn((callback: (error: Error | null, bus: any) => void) => callback(null, bus)),
    connect: vi.fn((callback: (error: Error | null) => void) => callback(null)),
    disconnect: vi.fn(),
    list: vi.fn(),
    describe: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
  };
  return {
    bus,
    api,
    Pm2Api: vi.fn(function Pm2Api() {
      return api;
    }),
  };
});

vi.mock('pm2/lib/API.js', () => ({ default: mocked.Pm2Api }));

let pm2Home: string;

beforeAll(async () => {
  pm2Home = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2-captain-client-'));
  // Only the presence of the daemon socket is checked before connecting.
  await fs.writeFile(libPath.join(pm2Home, 'rpc.sock'), '');
});

afterAll(async () => {
  await fs.rm(pm2Home, { recursive: true, force: true });
});

function createClient(home = pm2Home) {
  return createPm2Client({
    log: { info: vi.fn(), warn: vi.fn() },
    settings: { runtimeDaemonId: 'daemon-1', pm2Home: home },
    sshConnection: { isRemote: false, ensureConnected: vi.fn() },
  } as never);
}

describe('pm2Client', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocked.bus.removeAllListeners();
    mocked.api.connect.mockImplementation(callback => callback(null));
    mocked.api.launchBus.mockImplementation(callback => callback(null, mocked.bus));
    mocked.api.Client.pingDaemon.mockImplementation(callback => callback(true));
  });

  it('forwards exact PM2 stdout and stderr bus events', async () => {
    const client = createClient();
    const listener = vi.fn();
    client.onLog(listener);
    await client.initialize();
    await client.start(vi.fn());

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
    expect(mocked.api.disconnect).toHaveBeenCalledOnce();
  });

  it('connects a client directly to forwarded remote sockets', async () => {
    const ensureConnected = vi.fn();
    const client = createPm2Client({
      log: { info: vi.fn(), warn: vi.fn() },
      settings: { runtimeDaemonId: 'daemon-1', pm2Home: null },
      sshConnection: {
        isRemote: true,
        socketDirectory: '/tmp/pm2-captain-forward',
        ensureConnected,
      },
    } as never);

    await client.initialize();
    await client.start(vi.fn());

    expect(ensureConnected).toHaveBeenCalledOnce();
    expect(mocked.Pm2Api).toHaveBeenCalledWith({
      pm2_home: '/tmp/pm2-captain-forward',
      daemon_mode: false,
    });
    expect(mocked.api.Client.launchRPC).toHaveBeenCalledOnce();
    expect(mocked.api.connect).not.toHaveBeenCalled();
    await client.stop();
    await client.start(vi.fn());
    expect(mocked.Pm2Api).toHaveBeenCalledTimes(2);
    await client.stop();
    await client.dispose();
  });

  it('uses an isolated client for each local PM2 home', async () => {
    const client = createClient();

    await client.initialize();
    await client.start(vi.fn());

    expect(mocked.Pm2Api).toHaveBeenCalledWith({ pm2_home: pm2Home, daemon_mode: true });
    expect(mocked.api.connect).toHaveBeenCalledOnce();
    expect(mocked.api.Client.launchRPC).not.toHaveBeenCalled();
    await client.stop();
    await client.dispose();
  });

  it('leaves a PM2 home without a daemon socket untouched', async () => {
    const emptyHome = libPath.join(pm2Home, 'missing');
    const client = createClient(emptyHome);
    await client.initialize();

    await expect(client.start(vi.fn())).rejects.toThrow(`PM2 is not running in ${emptyHome}.`);

    // Constructing a PM2 client would create logs/, pids/ and modules/ there.
    expect(mocked.Pm2Api).not.toHaveBeenCalled();
    await expect(fs.access(emptyHome)).rejects.toThrow();
  });

  it('reports a stopped daemon instead of letting PM2 spawn one', async () => {
    mocked.api.Client.pingDaemon.mockImplementation(callback => callback(false));
    const client = createClient();
    await client.initialize();

    await expect(client.start(vi.fn())).rejects.toBeInstanceOf(Pm2DaemonUnavailableError);

    expect(mocked.api.connect).not.toHaveBeenCalled();
    expect(mocked.api.launchBus).not.toHaveBeenCalled();
  });

  it('refuses operations while disconnected', async () => {
    const client = createClient();

    await expect(client.list()).rejects.toBeInstanceOf(Pm2DaemonUnavailableError);
    await expect(client.restartProcess(0)).rejects.toBeInstanceOf(Pm2DaemonUnavailableError);

    expect(mocked.api.list).not.toHaveBeenCalled();
    expect(mocked.api.restart).not.toHaveBeenCalled();
  });

  it('times out callback operations that never settle', async () => {
    vi.useFakeTimers();
    mocked.api.list.mockImplementation(() => undefined);
    const client = createClient();
    await client.initialize();
    await client.start(vi.fn());

    const pending = expect(client.list()).rejects.toThrow('PM2 list timed out');
    await vi.advanceTimersByTimeAsync(10_000);

    await pending;
    await client.stop();
    await client.dispose();
  });

  it('reattaches the event bus after it closes', async () => {
    vi.useFakeTimers();
    const client = createClient();
    const statuses: boolean[] = [];
    client.onDaemonStatus(connected => statuses.push(connected));
    await client.initialize();
    await client.start(vi.fn());

    mocked.bus.emit('close');
    await vi.advanceTimersByTimeAsync(500);

    expect(mocked.api.launchBus).toHaveBeenCalledTimes(2);
    expect(mocked.api.connect).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([true, false, true]);
    await client.stop();
    await client.dispose();
  });

  it('waits for a stopped daemon to return without respawning it', async () => {
    vi.useFakeTimers();
    const client = createClient();
    const statuses: boolean[] = [];
    client.onDaemonStatus(connected => statuses.push(connected));
    await client.initialize();
    await client.start(vi.fn());

    mocked.api.Client.pingDaemon.mockImplementation(callback => callback(false));
    mocked.bus.emit('close');
    await vi.advanceTimersByTimeAsync(500);

    expect(mocked.api.connect).toHaveBeenCalledOnce();
    expect(statuses).toEqual([true, false]);

    mocked.api.Client.pingDaemon.mockImplementation(callback => callback(true));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocked.api.connect).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([true, false, true]);
    await client.stop();
    await client.dispose();
  });

  it('cancels pending reconnect work during shutdown', async () => {
    vi.useFakeTimers();
    const client = createClient();
    await client.initialize();
    await client.start(vi.fn());
    mocked.bus.emit('close');

    await client.stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocked.api.launchBus).toHaveBeenCalledOnce();
    await client.dispose();
  });
});
