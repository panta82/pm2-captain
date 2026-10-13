import { EventEmitter } from 'node:events';

import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IAppLifecycleMethods } from '../lib/app';
import { IFileCursor } from '../lib/log_file_reader';
import { IPM2LogEvent, Pm2DaemonUnavailableError } from '../lib/pm2_client';
import { IPm2Daemon } from '../lib/pm2_daemon';
import { FakeDaemon, IFakeConnectionHandlers, IFakeLocation } from './fake_daemon';

/**
 * Stands in for `pm2Daemon` in fake mode. It finds its daemon in the fake world
 * by the same location a real one would be reached at.
 */
export function createPm2Daemon({ settings, fakeWorld }: IContainer): IPm2Daemon {
  const events = new EventEmitter();
  // A local daemon always has a PM2 home. Without one, nothing is found there.
  const location: IFakeLocation = settings.sshArgs
    ? { kind: 'ssh', sshArgs: settings.sshArgs, pm2Home: settings.pm2Home }
    : { kind: 'local', pm2Home: settings.pm2Home ?? '' };
  const handlers: IFakeConnectionHandlers = {
    onLog: event => events.emit('log', event),
    onStatus: connected => events.emit('daemon-status', connected),
  };
  let daemon: FakeDaemon | null = null;

  const connected = () => {
    if (!daemon) {
      throw new Pm2DaemonUnavailableError();
    }
    return daemon;
  };

  const disconnect = async () => {
    daemon?.disconnect(handlers);
    daemon = null;
  };

  return new (class FakePm2Daemon implements IAppLifecycleMethods {
    get isLocal() {
      return location.kind === 'local';
    }

    get identity() {
      return daemon?.identity ?? fakeWorld.identityAt(location);
    }

    start = async () => {
      daemon = await fakeWorld.connect(location, handlers);
    };

    stop = disconnect;

    dispose = disconnect;

    list = async () => connected().list();

    describe = async (pmId: number) => connected().describe(pmId);

    startProcess = async (pmId: number) => connected().restartProcess(pmId);

    stopProcess = async (pmId: number) => connected().stopProcess(pmId);

    restartProcess = async (pmId: number) => connected().restartProcess(pmId);

    onLog = (listener: (event: IPM2LogEvent) => void) => {
      events.on('log', listener);
      return () => events.off('log', listener);
    };

    onDaemonStatus = (listener: (connected: boolean) => void) => {
      events.on('daemon-status', listener);
      return () => events.off('daemon-status', listener);
    };

    readLogLines = async (path: string | null, cursor: IFileCursor | null, limit: number) =>
      connected().readLogLines(path, cursor, limit);
  })();
}

export default define({
  createPm2Daemon,
});
