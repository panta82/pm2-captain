import libOs from 'node:os';
import type { ProcessDescription } from 'pm2';

import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IFileCursor, IReverseLinePage } from './log_file_reader';
import { IPM2LogEvent } from './pm2_client';

/** Who a PM2 daemon runs as, and on which computer. */
export interface IPm2DaemonIdentity {
  hostname: string;
  username: string;
}

/**
 * One PM2 daemon, wherever it runs. This is everything Captain's business
 * rules need from PM2, so another implementation can stand in for the real one.
 */
export interface IPm2Daemon {
  /**
   * False for a daemon on another computer: its PIDs and environment cannot be
   * compared with Captain's own.
   */
  readonly isLocal: boolean;
  /** Null while it is not known, as for a remote daemon that never connected. */
  readonly identity: IPm2DaemonIdentity | null;
  list(): Promise<ProcessDescription[]>;
  describe(pmId: number): Promise<ProcessDescription[]>;
  startProcess(pmId: number): Promise<unknown>;
  stopProcess(pmId: number): Promise<unknown>;
  restartProcess(pmId: number): Promise<unknown>;
  onLog(listener: (event: IPM2LogEvent) => void): () => void;
  onDaemonStatus(listener: (connected: boolean) => void): () => void;
  /** Reads the lines before `cursor` from a log file of this daemon, newest page first. */
  readLogLines(
    path: string | null,
    cursor: IFileCursor | null,
    limit: number
  ): Promise<IReverseLinePage>;
}

export function createPm2Daemon({
  pm2Client,
  sshConnection,
  logFileReader,
}: IContainer): IPm2Daemon {
  return new (class Pm2Daemon {
    get isLocal() {
      return !sshConnection.isRemote;
    }

    get identity() {
      if (sshConnection.isRemote) {
        const remoteInfo = sshConnection.remoteInfo;
        return remoteInfo && { hostname: remoteInfo.hostname, username: remoteInfo.username };
      }
      return { hostname: libOs.hostname(), username: libOs.userInfo().username };
    }

    list = () => pm2Client.list();

    describe = (pmId: number) => pm2Client.describe(pmId);

    startProcess = (pmId: number) => pm2Client.startProcess(pmId);

    stopProcess = (pmId: number) => pm2Client.stopProcess(pmId);

    restartProcess = (pmId: number) => pm2Client.restartProcess(pmId);

    onLog = (listener: (event: IPM2LogEvent) => void) => pm2Client.onLog(listener);

    onDaemonStatus = (listener: (connected: boolean) => void) => pm2Client.onDaemonStatus(listener);

    readLogLines = (path: string | null, cursor: IFileCursor | null, limit: number) =>
      logFileReader.readPreviousLines(path, cursor, limit);
  })();
}

export default define({
  createPm2Daemon,
});
