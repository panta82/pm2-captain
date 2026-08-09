import { EventEmitter } from 'node:events';
import pm2, { ProcessDescription } from 'pm2';

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

interface IPM2Module extends IPM2Api {
  custom: new (options: { pm2_home: string; daemon_mode: boolean }) => IPM2Api;
}

export function createPm2Client({ log, sshConnection }: IContainer) {
  const events = new EventEmitter();
  let pm2Api: IPM2Api | null = sshConnection.isRemote ? null : (pm2 as unknown as IPM2Api);
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

  const connect = async () => {
    if (!isConnected) {
      await sshConnection.ensureConnected();
      if (!pm2Api) {
        if (sshConnection.isRemote) {
          if (!sshConnection.socketDirectory) {
            throw new Error('The SSH socket forwarding directory is not available.');
          }
          const PM2 = pm2 as unknown as IPM2Module;
          pm2Api = new PM2.custom({
            pm2_home: sshConnection.socketDirectory,
            daemon_mode: false,
          });
        } else {
          pm2Api = pm2 as unknown as IPM2Api;
        }
      }
      if (sshConnection.isRemote) {
        await call<void>('connect', callback => pm2Api!.Client!.launchRPC(callback));
      } else {
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
      if (sshConnection.isRemote) {
        // SSH recreates its temporary socket directory on every start.
        pm2Api = null;
      }
    };

    dispose = async () => {
      if (isConnected) {
        pm2Api!.disconnect();
        isConnected = false;
      }
      pm2Api = null;
    };

    list = () => call<ProcessDescription[]>('list', callback => pm2Api!.list(callback));

    describe = (pmId: number) =>
      call<ProcessDescription[]>('describe', callback => pm2Api!.describe(pmId, callback));

    startProcess = (pmId: number) =>
      call<unknown>('start', callback => pm2Api!.restart(pmId, callback));

    stopProcess = (pmId: number) => call<unknown>('stop', callback => pm2Api!.stop(pmId, callback));

    restartProcess = (pmId: number) =>
      call<unknown>('restart', callback => pm2Api!.restart(pmId, callback));

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
