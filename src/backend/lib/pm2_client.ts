import { EventEmitter } from 'node:events';

import pm2, { ProcessDescription } from 'pm2';

import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IAppLifecycleMethods } from './app';

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

export function createPm2Client({ log }: IContainer) {
  const events = new EventEmitter();
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
      await call<void>('connect', callback => pm2.connect(callback));
      isConnected = true;
      events.emit('daemon-status', true);
      log.info('Connected to PM2');
    }
  };

  const attachBus = async () => {
    bus?.removeAllListeners?.();
    try {
      bus = await call<EventEmitter>('launchBus', callback => {
        pm2.launchBus((error, launchedBus) => callback(error, launchedBus as EventEmitter));
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
          pm2.disconnect();
          isConnected = false;
        }
        events.emit('daemon-status', false);
        scheduleReconnect();
      });
      log.info('PM2 event bus attached');
    } catch (error) {
      if (isConnected) {
        pm2.disconnect();
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
      await connect();
    };

    start = async () => {
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
    };

    dispose = async () => {
      if (isConnected) {
        pm2.disconnect();
        isConnected = false;
      }
    };

    list = () =>
      call<ProcessDescription[]>('list', callback => pm2.list(callback));

    describe = (pmId: number) =>
      call<ProcessDescription[]>('describe', callback => pm2.describe(pmId, callback));

    startProcess = (pmId: number) =>
      call<unknown>('start', callback => pm2.restart(pmId, callback as never));

    stopProcess = (pmId: number) =>
      call<unknown>('stop', callback => pm2.stop(pmId, callback as never));

    restartProcess = (pmId: number) =>
      call<unknown>('restart', callback => pm2.restart(pmId, callback as never));

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
