/// <reference path="./pm2_api.d.ts" />
import { EventEmitter } from 'node:events';
import { promises as fs, constants as fsConstants } from 'node:fs';
import libPath from 'node:path';
import type { ProcessDescription } from 'pm2';

import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IAppLifecycleMethods, IAppWaitForMethod } from './app';

export interface IPM2LogPacket {
  at?: number;
  data: string;
  process: {
    name: string;
    pm_id: number;
    namespace?: string;
  };
}

export interface IPM2LogEvent {
  type: 'out' | 'err';
  packet: IPM2LogPacket;
}

/**
 * The axon socket under PM2's RPC client or event bus. Its events describe the
 * connection itself.
 */
interface IPM2Socket extends EventEmitter {
  close(): void;
}

/**
 * PM2's event bus. `on` subscribes to a topic the daemon publishes. The bus is
 * not an EventEmitter and reports nothing about the connection.
 */
interface IPM2Bus {
  on(topic: string, listener: (packet: IPM2LogPacket) => void): void;
}

interface IPM2Api {
  Client?: {
    /** Set by launchRPC() and launchBus(). PM2 replaces them but never clears them. */
    client_sock?: IPM2Socket;
    sub_sock?: IPM2Socket;
    launchRPC(callback: (error: Error | null) => void): void;
    pingDaemon(callback: (isAlive: boolean) => void): void;
    executeRemote(
      method: string,
      args: object,
      callback: (error: Error | null, result: unknown) => void
    ): void;
  };
  connect(callback: (error: Error | null) => void): void;
  disconnect(): void;
  launchBus(callback: (error: Error | null, bus: IPM2Bus) => void): void;
  list(callback: (error: Error | null, processes: ProcessDescription[]) => void): void;
  describe(
    pmId: number,
    callback: (error: Error | null, processes: ProcessDescription[]) => void
  ): void;
  restart(pmId: number, callback: (error: Error | null, result: unknown) => void): void;
  stop(pmId: number, callback: (error: Error | null, result: unknown) => void): void;
}

type IPM2ApiConstructor = new (options: { pm2_home: string; daemon_mode: boolean }) => IPM2Api;

// The pm2 package entry builds a default client on import, and that creates
// ~/.pm2 even on a computer without PM2. The API class alone does not. It reads
// PM2_PROGRAMMATIC when it loads; without it, the first client in a new
// directory prints PM2's install banner.
async function loadPm2Api() {
  process.env.PM2_PROGRAMMATIC = 'true';
  return (await import('pm2/lib/API.js')).default as unknown as IPM2ApiConstructor;
}

export class Pm2DaemonUnavailableError extends Error {
  readonly code = 'PM2_DAEMON_UNAVAILABLE';

  constructor(message = 'Not connected to the PM2 daemon.') {
    super(message);
    this.name = 'Pm2DaemonUnavailableError';
  }
}

export function createPm2Client({ log, sshConnection, settings }: IContainer) {
  const events = new EventEmitter();
  let pm2Api: IPM2Api | null = null;
  let isConnected = false;
  let isStopping = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  // PM2 calls still waiting for their callback. A lost connection fails them
  // at once instead of leaving each one to its timeout.
  const pendingCalls = new Set<(error: Error) => void>();

  const call = <T>(
    name: string,
    operation: (callback: (error: Error | null, result: T) => void) => void,
    timeout = 10_000
  ) =>
    new Promise<T>((resolve, reject) => {
      const fail = (error: Error) => {
        clearTimeout(timer);
        pendingCalls.delete(fail);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(`PM2 ${name} timed out`)), timeout);
      pendingCalls.add(fail);
      operation((error, result) => {
        if (error) {
          fail(error);
        } else {
          clearTimeout(timer);
          pendingCalls.delete(fail);
          resolve(result);
        }
      });
    });

  // PM2 lazily starts (or embeds) a daemon when an operation runs on a
  // disconnected client, so operations are refused until connect() succeeds.
  const callConnected = <T>(
    name: string,
    operation: (callback: (error: Error | null, result: T) => void) => void
  ) => (isConnected ? call(name, operation) : Promise.reject(new Pm2DaemonUnavailableError()));

  // A PM2 client creates its directories when it is constructed, so a home
  // without a daemon socket is left alone. The socket must also be writable:
  // PM2 exits the whole process when connecting fails with EACCES. A daemon can
  // come back under another user, so this runs before every local attempt.
  const requireLocalHome = async () => {
    const pm2Home = settings.pm2Home;
    if (!pm2Home) {
      throw new Error('This daemon has no PM2 home.');
    }
    try {
      await fs.access(libPath.join(pm2Home, 'rpc.sock'), fsConstants.R_OK | fsConstants.W_OK);
    } catch (error) {
      throw new Pm2DaemonUnavailableError(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? `PM2 is not running in ${pm2Home}.`
          : `No permission to use the PM2 daemon in ${pm2Home}.`
      );
    }
    return pm2Home;
  };

  const createApi = async (localHome: string | null) => {
    const PM2Api = await loadPm2Api();
    if (localHome) {
      return new PM2Api({ pm2_home: localHome, daemon_mode: true });
    }
    if (!sshConnection.socketDirectory) {
      throw new Error('The SSH socket forwarding directory is not available.');
    }
    return new PM2Api({ pm2_home: sshConnection.socketDirectory, daemon_mode: false });
  };

  // Closes the current connection for good. PM2's own disconnect() only forgets
  // a socket that has already lost the daemon, and axon retries such a socket
  // forever. It would come back with the daemon, deliver every log line a
  // second time and send the requests that were queued on it in the meantime.
  const disconnect = () => {
    isConnected = false;
    for (const socket of [pm2Api?.Client?.client_sock, pm2Api?.Client?.sub_sock]) {
      if (!socket) {
        continue;
      }
      // This also removes PM2's and axon's own listeners, including the one
      // that sends queued requests on the next connect.
      socket.removeAllListeners();
      // close() does not cancel a retry axon has already scheduled. That last
      // attempt can still connect, or fail with an error nobody else handles.
      socket.on('connect', () => socket.close());
      socket.on('error', () => undefined);
      socket.close();
    }
    pm2Api?.disconnect();
    for (const fail of pendingCalls) {
      fail(new Pm2DaemonUnavailableError());
    }
  };

  const handleConnectionLost = (error?: Error) => {
    const wasConnected = isConnected;
    disconnect();
    if (wasConnected) {
      log.warn({ error }, 'Disconnected from PM2');
      events.emit('daemon-status', false);
      scheduleReconnect();
    }
  };

  // axon never reports a lost connection. It retries by itself and emits
  // `close` only for a socket that was closed on purpose, so its first retry,
  // about 100 ms after the loss, is the earliest sign that the daemon is gone.
  // An `error` without a listener would take the whole process down.
  const watchSocket = (socket: IPM2Socket) => {
    socket.on('reconnect attempt', () => handleConnectionLost());
    socket.on('error', handleConnectionLost);
  };

  const connect = async () => {
    if (isConnected) {
      return;
    }
    await sshConnection.ensureConnected();
    const localHome = sshConnection.isRemote ? null : await requireLocalHome();
    pm2Api ??= await createApi(localHome);
    const api = pm2Api;
    const client = api.Client!;
    if (localHome) {
      // pm2.connect() spawns a daemon when none is running. Captain only
      // observes an existing PM2, so a stopped one stays stopped.
      const isDaemonAlive = await call<boolean>('ping', callback =>
        client.pingDaemon(isAlive => callback(null, isAlive))
      );
      if (!isDaemonAlive) {
        throw new Pm2DaemonUnavailableError(`PM2 is not running in ${localHome}.`);
      }
    }
    try {
      await call<void>('connect', callback =>
        localHome ? api.connect(callback) : client.launchRPC(callback)
      );
      watchSocket(client.client_sock!);
      // An SSH-forwarded socket accepts connections even when no PM2 daemon
      // listens behind it, so only an answer proves that the daemon is there.
      await call<unknown>('RPC ping', callback => client.executeRemote('ping', {}, callback));
    } catch (error) {
      disconnect();
      throw error;
    }
    isConnected = true;
    events.emit('daemon-status', true);
    log.info('Connected to PM2');
  };

  const attachBus = async () => {
    const api = pm2Api!;
    try {
      const bus = await call<IPM2Bus>('launchBus', callback => api.launchBus(callback));
      watchSocket(api.Client!.sub_sock!);
      for (const type of ['out', 'err'] as const) {
        bus.on(`log:${type}`, packet => {
          if (typeof packet.data === 'string') {
            events.emit('log', { type, packet } satisfies IPM2LogEvent);
          }
        });
      }
      reconnectAttempt = 0;
      log.info('PM2 event bus attached');
    } catch (error) {
      // A lost socket has already been handled by the time its call fails here.
      if (isConnected) {
        log.warn({ error }, 'Unable to attach PM2 event bus');
        handleConnectionLost();
      }
    }
  };

  const scheduleReconnect = () => {
    if (isStopping || reconnectTimer) {
      return;
    }
    const delay = Math.min(30_000, 500 * 2 ** reconnectAttempt++);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect()
        .then(attachBus)
        .catch(error => {
          log.warn({ error, delay }, 'Unable to reconnect to PM2');
          scheduleReconnect();
        });
    }, delay);
    reconnectTimer.unref();
  };

  return new (class PM2Client implements IAppLifecycleMethods {
    initialize = async () => {
      isStopping = false;
    };

    start = async (waitFor: IAppWaitForMethod) => {
      await waitFor('sshConnection');
      isStopping = false;
      await connect();
      await attachBus();
    };

    stop = async () => {
      isStopping = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      disconnect();
      // The client is recreated on every start. SSH also recreates its
      // temporary socket directory.
      pm2Api = null;
    };

    dispose = async () => {
      disconnect();
      pm2Api = null;
    };

    list = () => callConnected<ProcessDescription[]>('list', callback => pm2Api!.list(callback));

    describe = (pmId: number) =>
      callConnected<ProcessDescription[]>('describe', callback => pm2Api!.describe(pmId, callback));

    startProcess = (pmId: number) =>
      callConnected<unknown>('start', callback => pm2Api!.restart(pmId, callback));

    stopProcess = (pmId: number) =>
      callConnected<unknown>('stop', callback => pm2Api!.stop(pmId, callback));

    restartProcess = (pmId: number) =>
      callConnected<unknown>('restart', callback => pm2Api!.restart(pmId, callback));

    onLog = (listener: (event: IPM2LogEvent) => void) => {
      events.on('log', listener);
      return () => events.off('log', listener);
    };

    onDaemonStatus = (listener: (connected: boolean) => void) => {
      events.on('daemon-status', listener);
      return () => events.off('daemon-status', listener);
    };
  })();
}

export default define({
  createPm2Client,
});
