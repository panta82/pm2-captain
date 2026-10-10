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

interface IPM2Api {
  Client?: {
    launchRPC(callback: (error: Error | null) => void): void;
    pingDaemon(callback: (isAlive: boolean) => void): void;
  };
  connect(callback: (error: Error | null) => void): void;
  disconnect(): void;
  launchBus(callback: (error: Error | null, bus: EventEmitter) => void): void;
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
  let bus: EventEmitter | null = null;
  let isConnected = false;
  let isStopping = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;

  const call = <T>(
    name: string,
    operation: (callback: (error: Error | null, result: T) => void) => void,
    timeout = 10_000
  ) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`PM2 ${name} timed out`)), timeout);
      operation((error, result) => {
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
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

  const createApi = async () => {
    const PM2Api = await loadPm2Api();
    if (sshConnection.isRemote) {
      if (!sshConnection.socketDirectory) {
        throw new Error('The SSH socket forwarding directory is not available.');
      }
      return new PM2Api({ pm2_home: sshConnection.socketDirectory, daemon_mode: false });
    }
    const pm2Home = settings.pm2Home;
    if (!pm2Home) {
      throw new Error('This daemon has no PM2 home.');
    }
    // A PM2 client creates its directories when it is constructed, so a home
    // without a daemon socket is left alone. The socket must also be writable:
    // PM2 exits the whole process when connecting fails with EACCES.
    const rpcSocket = libPath.join(pm2Home, 'rpc.sock');
    try {
      await fs.access(rpcSocket, fsConstants.R_OK | fsConstants.W_OK);
    } catch (error) {
      throw new Pm2DaemonUnavailableError(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? `PM2 is not running in ${pm2Home}.`
          : `No permission to use the PM2 daemon in ${pm2Home}.`
      );
    }
    return new PM2Api({ pm2_home: pm2Home, daemon_mode: true });
  };

  const connect = async () => {
    if (!isConnected) {
      await sshConnection.ensureConnected();
      pm2Api ??= await createApi();
      if (sshConnection.isRemote) {
        await call<void>('connect', callback => pm2Api!.Client!.launchRPC(callback));
      } else {
        // pm2.connect() spawns a daemon when none is running. Captain only
        // observes an existing PM2, so a stopped one stays stopped.
        const isDaemonAlive = await call<boolean>('ping', callback =>
          pm2Api!.Client!.pingDaemon(isAlive => callback(null, isAlive))
        );
        if (!isDaemonAlive) {
          throw new Pm2DaemonUnavailableError(`PM2 is not running in ${settings.pm2Home}.`);
        }
        await call<void>('connect', callback => pm2Api!.connect(callback));
      }
      isConnected = true;
      events.emit('daemon-status', true);
      log.info('Connected to PM2');
    }
  };

  const attachBus = async () => {
    bus?.removeAllListeners?.();
    try {
      bus = await call<EventEmitter>('launchBus', callback => {
        pm2Api!.launchBus((error, launchedBus) => callback(error, launchedBus as EventEmitter));
      });
      reconnectAttempt = 0;
      for (const type of ['out', 'err'] as const) {
        bus.on(`log:${type}`, (packet: IPM2LogPacket) => {
          if (typeof packet.data === 'string') {
            events.emit('log', { type, packet } satisfies IPM2LogEvent);
          }
        });
      }
      bus.on('close', () => {
        bus = null;
        if (isConnected) {
          pm2Api!.disconnect();
          isConnected = false;
        }
        events.emit('daemon-status', false);
        scheduleReconnect();
      });
      log.info('PM2 event bus attached');
    } catch (error) {
      if (isConnected) {
        pm2Api!.disconnect();
        isConnected = false;
      }
      events.emit('daemon-status', false);
      log.warn({ error }, 'Unable to attach PM2 event bus');
      scheduleReconnect();
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
          isConnected = false;
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
      bus?.removeAllListeners?.();
      bus = null;
      if (isConnected) {
        pm2Api!.disconnect();
        isConnected = false;
      }
      // The client is recreated on every start. SSH also recreates its
      // temporary socket directory.
      pm2Api = null;
    };

    dispose = async () => {
      if (isConnected) {
        pm2Api!.disconnect();
        isConnected = false;
      }
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
