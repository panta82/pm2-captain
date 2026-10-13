import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Pm2DaemonUnavailableError, createPm2Client } from '../../../../src/backend/lib/pm2_client';

type IRpcCallback = (error: Error | null, result?: unknown) => void;

// A stand-in for PM2's client that keeps the behavior Captain depends on: the
// bus only delivers published topics, a lost daemon is never announced, the
// sockets retry on their own, and PM2's disconnect() skips a socket that is not
// connected. Tests change the daemon, never the client's sockets or bus.
const mocked = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');

  const daemon = {
    /** Something accepts connections: PM2 itself, or an SSH forward. */
    isListening: true,
    /** PM2 is behind the socket. A forward keeps listening without it. */
    isRunning: true,
    isAnswering: true,
    /** The socket files belong to someone else, so connecting fails with EACCES. */
    isDenying: false,
    /** RPC methods that reached the daemon. */
    requests: [] as string[],
    /** How often PM2's client would have started a daemon of its own. */
    spawnCount: 0,
    sockets: [] as FakeSocket[],

    kill(isForwardStillUp = false) {
      this.isRunning = false;
      this.isListening = isForwardStillUp;
      for (const socket of this.sockets) {
        if (socket.connected) {
          socket.drop();
        }
      }
    },

    start() {
      this.isRunning = true;
      this.isListening = true;
    },

    /** Breaks every connection with a socket error axon does not ignore. */
    breakConnections(code: string) {
      for (const socket of this.sockets) {
        if (socket.connected) {
          socket.fail(code);
        }
      }
    },

    publish(topic: string, packet: unknown) {
      for (const socket of this.sockets) {
        if (socket.connected) {
          socket.topics.get(topic)?.forEach(listener => listener(packet));
        }
      }
    },

    get connectionCount() {
      return this.sockets.filter(socket => socket.connected).length;
    },
  };

  /** The client side of pm2-axon's lib/sockets/sock.js. */
  class FakeSocket extends EventEmitter {
    connected = false;
    closing = false;
    retry = 100;
    queue: Array<() => void> = [];
    topics = new Map<string, Array<(packet: unknown) => void>>();

    constructor() {
      super();
      daemon.sockets.push(this);
      // axon's queue plugin: requests made without a peer go out on the next connect.
      this.on('connect', () => {
        for (const send of this.queue.splice(0)) {
          send();
        }
      });
    }

    connect() {
      if (daemon.isDenying) {
        this.fail('EACCES');
        return;
      }
      if (!daemon.isListening) {
        this.drop();
        return;
      }
      this.connected = true;
      this.retry = 100;
      this.emit('connect');
      if (!daemon.isRunning) {
        // A forward accepts first and gives up once the far socket refuses.
        setTimeout(() => {
          if (this.connected) {
            this.drop();
          }
        }, 1);
      }
    }

    /** The peer is gone. axon does not report that; it retries on its own. */
    drop() {
      this.connected = false;
      if (this.closing) {
        this.emit('close');
        return;
      }
      const retry = this.retry;
      setTimeout(() => {
        this.emit('reconnect attempt');
        this.retry = Math.min(5_000, Math.round(retry * 1.5));
        this.connect();
      }, retry);
    }

    /** axon emits `error` for the codes it does not ignore, then carries on as for any loss. */
    fail(code: string) {
      this.emit('error', Object.assign(new Error(code), { code }));
      this.drop();
    }

    /** Like axon, this does not cancel a retry that is already scheduled. */
    close() {
      this.closing = true;
      if (this.connected) {
        this.drop();
      }
    }

    send(method: string, callback: IRpcCallback) {
      const deliver = () => {
        if (!daemon.isRunning) {
          return;
        }
        daemon.requests.push(method);
        if (daemon.isAnswering) {
          callback(null, []);
        }
      };
      if (this.connected) {
        deliver();
      } else {
        this.queue.push(deliver);
      }
    }
  }

  const createApi = () => {
    const client = {
      client: null as object | null,
      client_sock: undefined as FakeSocket | undefined,
      sub_sock: undefined as FakeSocket | undefined,
      launchRPC: vi.fn((callback: IRpcCallback) => openRpc(callback)),
      pingDaemon: vi.fn((callback: (isAlive: boolean) => void) => callback(daemon.isListening)),
      executeRemote(method: string, _args: object, callback: IRpcCallback) {
        if (!client.client) {
          // PM2 starts a daemon for a call on a client without an RPC connection.
          daemon.spawnCount += 1;
          return;
        }
        client.client_sock!.send(method, callback);
      },
    };
    const openRpc = (callback: IRpcCallback) => {
      const socket = new FakeSocket();
      client.client = {};
      client.client_sock = socket;
      socket.once('connect', () => callback(null));
      socket.connect();
    };
    return {
      Client: client,
      connect: vi.fn((callback: IRpcCallback) => {
        if (daemon.isListening) {
          openRpc(callback);
        } else {
          // PM2 starts a daemon when it finds none.
          daemon.spawnCount += 1;
        }
      }),
      launchBus: vi.fn((callback: (error: Error | null, bus: object, socket: object) => void) => {
        const socket = new FakeSocket();
        client.sub_sock = socket;
        // An axon sub-emitter: `on` subscribes to a published topic, nothing else.
        const bus = {
          on(topic: string, listener: (packet: unknown) => void) {
            socket.topics.set(topic, [...(socket.topics.get(topic) || []), listener]);
            return bus;
          },
        };
        socket.once('connect', () => callback(null, bus, socket));
        socket.connect();
      }),
      disconnect: vi.fn(() => {
        for (const socket of [client.client_sock, client.sub_sock]) {
          if (socket?.connected && !socket.closing) {
            socket.close();
          }
        }
        client.client = null;
      }),
      list: vi.fn((callback: IRpcCallback) => client.executeRemote('getMonitorData', {}, callback)),
      describe: vi.fn((_pmId: number, callback: IRpcCallback) =>
        client.executeRemote('getMonitorData', {}, callback)
      ),
      stop: vi.fn((_pmId: number, callback: IRpcCallback) =>
        client.executeRemote('stopProcessId', {}, callback)
      ),
      restart: vi.fn((_pmId: number, callback: IRpcCallback) =>
        client.executeRemote('restartProcessId', {}, callback)
      ),
    };
  };

  const state = {
    daemon,
    /** The most recently constructed PM2 client. */
    api: undefined as unknown as ReturnType<typeof createApi>,
    Pm2Api: vi.fn(function Pm2Api() {
      state.api = createApi();
      return state.api;
    }),
    access: vi.fn(),
    actualAccess: undefined as unknown as typeof fs.access,
  };
  return state;
});

vi.mock('pm2/lib/API.js', () => ({ default: mocked.Pm2Api }));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  mocked.actualAccess = actual.promises.access;
  return { ...actual, promises: { ...actual.promises, access: mocked.access } };
});

const PACKET = {
  data: 'captain',
  process: { name: 'fixture', pm_id: 7 },
};

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

function createRemoteClient() {
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
  return { client, ensureConnected };
}

/** Starts a client under fake time and records what it reports. */
async function startWatchedClient(client = createClient()) {
  vi.useFakeTimers();
  // Reconnecting checks the daemon socket on the file system, and fake time
  // does not wait for real file access.
  mocked.access.mockResolvedValue(undefined);
  const statuses: boolean[] = [];
  const logListener = vi.fn();
  client.onDaemonStatus(connected => statuses.push(connected));
  client.onLog(logListener);
  await client.initialize();
  await client.start(vi.fn());
  return { client, statuses, logListener };
}

describe('pm2Client', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocked.access.mockImplementation(mocked.actualAccess);
    mocked.daemon.start();
    mocked.daemon.isAnswering = true;
    mocked.daemon.isDenying = false;
    mocked.daemon.requests = [];
    mocked.daemon.spawnCount = 0;
    mocked.daemon.sockets = [];
  });

  it('forwards exact PM2 stdout and stderr bus events', async () => {
    const client = createClient();
    const listener = vi.fn();
    client.onLog(listener);
    await client.initialize();
    await client.start(vi.fn());

    mocked.daemon.publish('log:out', PACKET);
    mocked.daemon.publish('log:err', PACKET);

    expect(listener).toHaveBeenNthCalledWith(1, { type: 'out', packet: PACKET });
    expect(listener).toHaveBeenNthCalledWith(2, { type: 'err', packet: PACKET });
    await client.stop();
    await client.dispose();
    expect(mocked.api.disconnect).toHaveBeenCalledOnce();
    expect(mocked.daemon.connectionCount).toBe(0);
  });

  it('connects a client directly to forwarded remote sockets', async () => {
    const { client, ensureConnected } = createRemoteClient();

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

  it('does not trust a forwarded socket that has no PM2 daemon behind it', async () => {
    mocked.daemon.kill(true);
    const { client } = createRemoteClient();
    const statuses: boolean[] = [];
    client.onDaemonStatus(connected => statuses.push(connected));
    await client.initialize();

    await expect(client.start(vi.fn())).rejects.toBeInstanceOf(Pm2DaemonUnavailableError);

    expect(statuses).toEqual([]);
    expect(mocked.daemon.requests).toEqual([]);
    await client.stop();
    await client.dispose();
  });

  it('keeps a forwarded daemon disconnected until PM2 answers again', async () => {
    const { client, statuses } = await startWatchedClient(createRemoteClient().client);

    mocked.daemon.kill(true);
    // Two reconnect attempts reach the forward and find nothing behind it.
    await vi.advanceTimersByTimeAsync(3_000);

    expect(mocked.api.Client.launchRPC).toHaveBeenCalledTimes(3);
    expect(statuses).toEqual([true, false]);

    mocked.daemon.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(statuses).toEqual([true, false, true]);
    expect(mocked.daemon.connectionCount).toBe(2);
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
    mocked.daemon.kill();
    const client = createClient();
    await client.initialize();

    await expect(client.start(vi.fn())).rejects.toBeInstanceOf(Pm2DaemonUnavailableError);

    expect(mocked.api.connect).not.toHaveBeenCalled();
    expect(mocked.api.launchBus).not.toHaveBeenCalled();
    expect(mocked.daemon.spawnCount).toBe(0);
  });

  it('refuses operations while disconnected', async () => {
    const client = createClient();

    await expect(client.list()).rejects.toBeInstanceOf(Pm2DaemonUnavailableError);
    await expect(client.restartProcess(0)).rejects.toBeInstanceOf(Pm2DaemonUnavailableError);

    expect(mocked.Pm2Api).not.toHaveBeenCalled();
  });

  it('times out callback operations that never settle', async () => {
    const { client } = await startWatchedClient();
    mocked.daemon.isAnswering = false;

    const pending = expect(client.list()).rejects.toThrow('PM2 list timed out');
    await vi.advanceTimersByTimeAsync(10_000);

    await pending;
    await client.stop();
    await client.dispose();
  });

  it('notices a killed daemon and refuses operations at once', async () => {
    const { client, statuses } = await startWatchedClient();
    mocked.daemon.isAnswering = false;
    const inFlight = expect(client.describe(7)).rejects.toBeInstanceOf(Pm2DaemonUnavailableError);

    mocked.daemon.kill();
    // The first sign of the loss is axon's own retry, 100 ms later.
    await vi.advanceTimersByTimeAsync(100);

    expect(statuses).toEqual([true, false]);
    await inFlight;
    await expect(client.list()).rejects.toBeInstanceOf(Pm2DaemonUnavailableError);
    expect(mocked.daemon.spawnCount).toBe(0);
    await client.stop();
    await client.dispose();
  });

  it('reconnects to a returning daemon and delivers each log line once', async () => {
    const { client, statuses, logListener } = await startWatchedClient();

    mocked.daemon.kill();
    await vi.advanceTimersByTimeAsync(100);
    mocked.daemon.start();
    await vi.advanceTimersByTimeAsync(500);

    expect(statuses).toEqual([true, false, true]);
    // Long enough for any socket of the lost connection to have retried.
    await vi.advanceTimersByTimeAsync(10_000);
    mocked.daemon.publish('log:out', PACKET);
    expect(logListener).toHaveBeenCalledOnce();
    expect(mocked.daemon.connectionCount).toBe(2);
    await client.stop();
    await client.dispose();
    expect(mocked.daemon.connectionCount).toBe(0);
  });

  it('never sends a request from the outage to the returning daemon', async () => {
    const { client, statuses, logListener } = await startWatchedClient();

    mocked.daemon.kill();
    // Captain has not noticed yet, so axon queues this for its next connection.
    const restart = expect(client.restartProcess(7)).rejects.toBeInstanceOf(
      Pm2DaemonUnavailableError
    );
    // The daemon is back before that retry, which then connects after all.
    mocked.daemon.start();
    await vi.advanceTimersByTimeAsync(100);
    await restart;
    await vi.advanceTimersByTimeAsync(500);

    expect(statuses).toEqual([true, false, true]);
    expect(mocked.daemon.requests).not.toContain('restartProcessId');
    mocked.daemon.publish('log:out', PACKET);
    expect(logListener).toHaveBeenCalledOnce();
    expect(mocked.daemon.connectionCount).toBe(2);
    await client.stop();
    await client.dispose();
  });

  it('waits for a stopped daemon to return without respawning it', async () => {
    const { client, statuses } = await startWatchedClient();

    mocked.daemon.kill();
    await vi.advanceTimersByTimeAsync(100 + 500);

    expect(mocked.api.Client.pingDaemon).toHaveBeenCalledTimes(2);
    expect(mocked.api.connect).toHaveBeenCalledOnce();
    expect(statuses).toEqual([true, false]);

    mocked.daemon.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocked.api.connect).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([true, false, true]);
    expect(mocked.daemon.spawnCount).toBe(0);
    await client.stop();
    await client.dispose();
  });

  it('survives a daemon that returns under another user', async () => {
    const { client, statuses } = await startWatchedClient();

    mocked.daemon.kill();
    mocked.daemon.start();
    mocked.daemon.isDenying = true;
    mocked.access.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await vi.advanceTimersByTimeAsync(100 + 500);

    // PM2's ping exits the whole process on EACCES, so it must not be tried.
    expect(mocked.api.Client.pingDaemon).toHaveBeenCalledOnce();
    expect(statuses).toEqual([true, false]);

    mocked.daemon.isDenying = false;
    mocked.access.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(statuses).toEqual([true, false, true]);
    await client.stop();
    await client.dispose();
  });

  it('treats a socket error as a lost connection', async () => {
    const { client, statuses } = await startWatchedClient();

    // Nobody else listens for `error` on these sockets, so it would be thrown.
    mocked.daemon.breakConnections('EIO');

    expect(statuses).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(500);
    expect(statuses).toEqual([true, false, true]);
    expect(mocked.daemon.connectionCount).toBe(2);
    await client.stop();
    await client.dispose();
  });

  it('cancels pending reconnect work during shutdown', async () => {
    const { client } = await startWatchedClient();
    mocked.daemon.kill();
    await vi.advanceTimersByTimeAsync(100);

    await client.stop();

    // Neither Captain nor a socket of the lost connection is still retrying.
    expect(vi.getTimerCount()).toBe(0);
    mocked.daemon.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocked.api.launchBus).toHaveBeenCalledOnce();
    expect(mocked.daemon.connectionCount).toBe(0);
    await client.dispose();
  });

  it('fails calls in flight and clears their timers on shutdown', async () => {
    const { client } = await startWatchedClient();
    mocked.daemon.isAnswering = false;
    const inFlight = expect(client.list()).rejects.toBeInstanceOf(Pm2DaemonUnavailableError);

    await client.stop();

    await inFlight;
    expect(mocked.daemon.connectionCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await client.dispose();
  });
});
