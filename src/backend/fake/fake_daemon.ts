import { createHash } from 'node:crypto';
import type { ProcessDescription } from 'pm2';

import type { IDaemonColor, IDaemonConfig } from '../../shared/contracts';
import { resolveLocalPath } from '../backend_settings';
import { IFileCursor, IReverseLinePage } from '../lib/log_file_reader';
import { IPM2LogEvent, Pm2DaemonUnavailableError } from '../lib/pm2_client';
import { IPm2DaemonIdentity } from '../lib/pm2_daemon';
import { SshConnectionError } from '../lib/ssh_connection';
import { FakeLogFile, generateLogEntry } from './fake_logs';
import {
  IFakeDaemonFields,
  IFakeDaemonInput,
  IFakeProcessFields,
  IFakeProcessInput,
} from './fake_scenario';

/** Where a daemon is, in the terms Captain uses to tell daemons apart. */
export type IFakeLocation =
  { kind: 'local'; pm2Home: string } | { kind: 'ssh'; sshArgs: string[]; pm2Home: string | null };

/** What a connected Captain daemon hears from its simulated PM2. */
export interface IFakeConnectionHandlers {
  onLog(event: IPM2LogEvent): void;
  onStatus(connected: boolean): void;
}

/** A simulated process, addressed by its name or its PM2 ID. */
export type IFakeProcessReference = string | number;

/** A simulated process. Metrics are the values it has while online. */
export interface IFakeProcess extends Required<Omit<IFakeProcessFields, 'uptimeMs'>> {
  pmId: number;
  name: string;
  instances: number;
  createdAt: number;
  startedAt: number;
}

/** Every local fake daemon runs on this one made-up computer. */
export const FAKE_LOCAL_IDENTITY: IPm2DaemonIdentity = {
  hostname: 'fake-host',
  username: 'captain',
};

const DEFAULT_UPTIME_MS = 2 * 60 * 60 * 1000;
/** A stalled timer must not release a flood of generated entries. */
const MAX_ENTRIES_PER_TICK = 1_000;
const EMPTY_PAGE: IReverseLinePage = {
  lines: [],
  cursor: null,
  hasMore: false,
  rotated: false,
  truncated: false,
};

export class FakeTargetNotFoundError extends Error {
  readonly code = 'FAKE_TARGET_NOT_FOUND';

  constructor(message: string) {
    super(message);
    this.name = 'FakeTargetNotFoundError';
  }
}

export function fakeLocationKey(location: IFakeLocation) {
  return location.kind === 'local'
    ? `local:${location.pm2Home}`
    : `ssh:${JSON.stringify(location.sshArgs)}:${location.pm2Home ?? ''}`;
}

// The same key always gets the same daemon ID, so the URLs of a scenario are stable.
function daemonIdFor(key: string) {
  const bytes = createHash('sha1').update(`pm2-captain-fake:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function delay(milliseconds: number) {
  return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}

/** One simulated PM2 daemon: its processes, its log files and whoever is connected to it. */
export class FakeDaemon {
  readonly key: string;
  readonly daemonId: string;
  readonly location: IFakeLocation;
  readonly label: string | null;
  readonly color: IDaemonColor | null;
  readonly isRegistered: boolean;
  _fields: Required<IFakeDaemonFields>;
  _processes: IFakeProcess[] = [];
  _logFiles = new Map<string, FakeLogFile>();
  _connections = new Set<IFakeConnectionHandlers>();
  /** Fractions of a generated entry carried over between ticks, by PM2 ID. */
  _logBudgets = new Map<number, number>();
  _nextPmId = 0;
  _nextPid = 4_000;

  constructor(
    input: IFakeDaemonInput,
    readonly _random: () => number
  ) {
    const kind = input.kind ?? (input.sshArgs ? 'ssh' : 'local');
    this.key = input.key;
    this.daemonId = daemonIdFor(input.key);
    this.label = input.label ?? null;
    this.color = input.color ?? null;
    this.isRegistered = input.isRegistered ?? true;
    this._fields = {
      isUp: input.isUp ?? true,
      error: input.error ?? null,
      connectDelayMs: input.connectDelayMs ?? 0,
      latencyMs: input.latencyMs ?? 0,
      hostname: input.hostname ?? (kind === 'ssh' ? input.key : FAKE_LOCAL_IDENTITY.hostname),
      username: input.username ?? (kind === 'ssh' ? 'deploy' : FAKE_LOCAL_IDENTITY.username),
    };
    // Captain normalizes the location of a daemon it stores, so the same form is kept here.
    this.location =
      kind === 'ssh'
        ? {
            kind,
            sshArgs: input.sshArgs ?? [`deploy@${input.key}`],
            pm2Home: input.pm2Home?.replace(/(.)\/+$/, '$1') ?? null,
          }
        : { kind, pm2Home: resolveLocalPath(input.pm2Home ?? `/srv/${input.key}/.pm2`) };
    for (const process of input.processes ?? []) {
      this.addProcess(process);
    }
  }

  get isUp() {
    return this._fields.isUp;
  }

  get identity(): IPm2DaemonIdentity {
    return { hostname: this._fields.hostname, username: this._fields.username };
  }

  /** How Captain stores this daemon when the scenario registers it. */
  get config(): IDaemonConfig {
    const appearance = {
      ...(this.label ? { label: this.label } : {}),
      ...(this.color ? { color: this.color } : {}),
    };
    return this.location.kind === 'local'
      ? { daemonId: this.daemonId, kind: 'local', pm2Home: this.location.pm2Home, ...appearance }
      : {
          daemonId: this.daemonId,
          kind: 'ssh',
          sshArgs: this.location.sshArgs,
          ...(this.location.pm2Home ? { pm2Home: this.location.pm2Home } : {}),
          ...appearance,
        };
  }

  get _logDirectory() {
    const pm2Home =
      this.location.pm2Home?.replace(/^~/, `/home/${this._fields.username}`) ??
      `/home/${this._fields.username}/.pm2`;
    return `${pm2Home}/logs`;
  }

  // ********************************************************************************************
  // Control: what scenarios and commands do to the daemon.

  set = (fields: IFakeDaemonFields) => {
    const wasUp = this._fields.isUp;
    Object.assign(this._fields, fields);
    if (this._fields.isUp !== wasUp) {
      for (const connection of this._connections) {
        connection.onStatus(this._fields.isUp);
      }
    }
  };

  addProcess = (input: IFakeProcessInput) => {
    const { name, instances = 1, history = 0, uptimeMs = DEFAULT_UPTIME_MS, ...fields } = input;
    const now = Date.now();
    for (let instance = 0; instance < instances; instance++) {
      const pmId = this._nextPmId++;
      const isOnline = (fields.status ?? 'online') === 'online';
      // PM2 gives every cluster instance its own pair of log files.
      const logSuffix = instances > 1 ? `-${instance}` : '';
      const process: IFakeProcess = {
        namespace: 'default',
        status: 'online',
        pid: isOnline ? this._nextPid++ : null,
        mode: instances > 1 ? 'cluster' : 'fork',
        cpu: 0.5,
        memory: 64 * 1024 * 1024,
        restarts: 0,
        unstableRestarts: 0,
        version: '1.0.0',
        watching: false,
        script: `/srv/apps/${name}/dist/index.js`,
        args: [],
        cwd: `/srv/apps/${name}`,
        interpreter: 'node',
        nodeVersion: '22.20.0',
        exitCode: null,
        cronRestart: null,
        outLogPath: `${this._logDirectory}/${name}-out${logSuffix}.log`,
        errLogPath: `${this._logDirectory}/${name}-error${logSuffix}.log`,
        env: { NODE_ENV: 'production' },
        actionDelayMs: 0,
        nextActionError: null,
        metricJitter: 0,
        logRate: 0,
        logProfile: 'timestamped',
        logErrorRatio: 0.1,
        ...fields,
        pmId,
        name,
        instances,
        createdAt: now - uptimeMs,
        startedAt: now - uptimeMs,
      };
      this._processes.push(process);
      // The backlog ends now and is spaced the way the process would have written it.
      const interval = process.logRate > 0 ? 1_000 / process.logRate : 1_000;
      for (let entry = 0; entry < history; entry++) {
        this._generateLog(process, now - (history - entry) * interval, false);
      }
    }
  };

  removeProcess = (reference: IFakeProcessReference) => {
    const process = this._findProcess(reference);
    this._processes.splice(this._processes.indexOf(process), 1);
    this._logBudgets.delete(process.pmId);
  };

  setProcess = (reference: IFakeProcessReference, fields: IFakeProcessFields) => {
    const process = this._findProcess(reference);
    const { uptimeMs, ...ownFields } = fields;
    Object.assign(process, ownFields);
    if (uptimeMs !== undefined) {
      process.startedAt = Date.now() - uptimeMs;
    }
    // A status alone keeps the PID believable: running processes have one, dead ones do not.
    if (fields.status !== undefined && fields.pid === undefined) {
      if (fields.status === 'online' && process.pid === null) {
        process.pid = this._nextPid++;
        if (uptimeMs === undefined) {
          process.startedAt = Date.now();
        }
      } else if (fields.status === 'stopped' || fields.status === 'errored') {
        process.pid = null;
      }
    }
  };

  /** Writes the lines now, so they reach the log file and anyone watching live. */
  emitLog = (
    reference: IFakeProcessReference,
    channel: 'out' | 'err',
    lines: string[],
    repeat = 1
  ) => {
    const process = this._findProcess(reference);
    for (let round = 1; round <= repeat; round++) {
      for (const line of lines) {
        this._writeLog(process, channel, line.replaceAll('{n}', String(round)), Date.now(), true);
      }
    }
  };

  /** Changes what is already in the log file, without anyone seeing it arrive. */
  setLogHistory = (
    reference: IFakeProcessReference,
    channel: 'out' | 'err',
    lines: string[],
    mode: 'replace' | 'append'
  ) => {
    const file = this._logFile(this._logPath(this._findProcess(reference), channel));
    if (!file) {
      return;
    }
    if (mode === 'replace') {
      file.replace(lines);
    } else {
      for (const line of lines) {
        file.append(line);
      }
    }
  };

  /** Starts the log file over, like a rotation that moves the old file away. */
  rotateLog = (reference: IFakeProcessReference, channel?: 'out' | 'err') => {
    const process = this._findProcess(reference);
    const paths = new Set(
      (channel ? [channel] : (['out', 'err'] as const)).map(item => this._logPath(process, item))
    );
    for (const path of paths) {
      this._logFile(path)?.rotate();
    }
  };

  /** Lets the processes write the log entries that were due in the elapsed time. */
  tick = (elapsedMs: number, now: number) => {
    for (const process of this._processes) {
      if (process.status !== 'online' || process.logRate <= 0) {
        continue;
      }
      const budget =
        (this._logBudgets.get(process.pmId) ?? 0) + (process.logRate * elapsedMs) / 1_000;
      const count = Math.min(Math.floor(budget), MAX_ENTRIES_PER_TICK);
      this._logBudgets.set(process.pmId, Math.min(budget - count, 1));
      for (let entry = 0; entry < count; entry++) {
        this._generateLog(process, now, true);
      }
    }
  };

  snapshot = () => ({
    key: this.key,
    daemonId: this.daemonId,
    ...this.location,
    label: this.label,
    color: this.color,
    isRegistered: this.isRegistered,
    ...this._fields,
    connections: this._connections.size,
    processes: this._processes.map(process => ({
      ...process,
      logLines: {
        out: this._logFile(process.outLogPath)?.lineCount ?? 0,
        err: this._logFile(process.errLogPath)?.lineCount ?? 0,
      },
    })),
  });

  // ********************************************************************************************
  // The PM2 side: what a connected Captain daemon can do.

  connect = async (handlers: IFakeConnectionHandlers) => {
    if (this._fields.connectDelayMs) {
      await delay(this._fields.connectDelayMs);
    }
    if (!this._fields.isUp) {
      const reason = this._fields.error;
      throw this.location.kind === 'ssh'
        ? new SshConnectionError(
            reason ??
              `ssh: connect to host ${this.location.sshArgs.at(-1)} port 22: Connection refused`
          )
        : new Pm2DaemonUnavailableError(
            reason ?? `PM2 is not running in ${this.location.pm2Home}.`
          );
    }
    this._connections.add(handlers);
  };

  disconnect = (handlers: IFakeConnectionHandlers) => {
    this._connections.delete(handlers);
  };

  list = () => this._call(() => this._processes.map(this._describe));

  describe = (pmId: number) =>
    this._call(() => this._processes.filter(process => process.pmId === pmId).map(this._describe));

  stopProcess = (pmId: number) => this._call(() => this._runAction(pmId, 'stop'));

  /** PM2 starts a stopped process through the same call. */
  restartProcess = (pmId: number) => this._call(() => this._runAction(pmId, 'restart'));

  readLogLines = (path: string | null, cursor: IFileCursor | null, limit: number) =>
    this._call(() => this._logFile(path)?.readPreviousLines(cursor, limit) ?? EMPTY_PAGE);

  _call = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (this._fields.latencyMs) {
      await delay(this._fields.latencyMs);
    }
    if (!this._fields.isUp) {
      throw new Pm2DaemonUnavailableError();
    }
    return operation();
  };

  _runAction = async (pmId: number, action: 'stop' | 'restart') => {
    const process = this._processes.find(item => item.pmId === pmId);
    if (!process) {
      throw new Error('process or namespace not found');
    }
    if (process.nextActionError !== null) {
      const message = process.nextActionError;
      process.nextActionError = null;
      throw new Error(message);
    }
    const wasOnline = process.status === 'online';
    if (process.actionDelayMs) {
      process.status = action === 'stop' ? 'stopping' : 'launching';
      await delay(process.actionDelayMs);
    }
    if (action === 'stop') {
      process.status = 'stopped';
      process.pid = null;
      process.exitCode = 0;
      return;
    }
    process.status = 'online';
    // Captain's own process keeps standing for this Captain.
    if (process.pid !== 'captain') {
      process.pid = this._nextPid++;
    }
    process.startedAt = Date.now();
    if (wasOnline) {
      process.restarts++;
    }
  };

  _describe = (process: IFakeProcess): ProcessDescription => {
    const isOnline = process.status === 'online';
    const wander = (value: number) => value * (1 + process.metricJitter * (Math.random() * 2 - 1));
    return {
      pid: process.pid === 'captain' ? global.process.pid : (process.pid ?? 0),
      name: process.name,
      pm_id: process.pmId,
      monit: {
        cpu: isOnline ? Math.round(wander(process.cpu) * 10) / 10 : 0,
        memory: isOnline ? Math.round(wander(process.memory)) : 0,
      },
      pm2_env: {
        ...process.env,
        pm_id: process.pmId,
        name: process.name,
        namespace: process.namespace,
        status: process.status,
        exec_mode: process.mode === 'cluster' ? 'cluster_mode' : 'fork_mode',
        pm_uptime: process.startedAt,
        created_at: process.createdAt,
        restart_time: process.restarts,
        unstable_restarts: process.unstableRestarts,
        version: process.version,
        watch: process.watching,
        pm_exec_path: process.script,
        args: process.args,
        pm_cwd: process.cwd,
        exec_interpreter: process.interpreter,
        node_version: process.nodeVersion,
        instances: process.instances,
        exit_code: process.exitCode,
        cron_restart: process.cronRestart,
        pm_out_log_path: process.outLogPath,
        pm_err_log_path: process.errLogPath,
      },
    } as ProcessDescription;
  };

  _findProcess = (reference: IFakeProcessReference) => {
    const process = this._processes.find(item =>
      typeof reference === 'number' ? item.pmId === reference : item.name === reference
    );
    if (!process) {
      throw new FakeTargetNotFoundError(
        `The fake daemon "${this.key}" has no process "${reference}".`
      );
    }
    return process;
  };

  _logPath = (process: IFakeProcess, channel: 'out' | 'err') =>
    channel === 'out' ? process.outLogPath : process.errLogPath;

  /** Null for a path that keeps nothing, like /dev/null. */
  _logFile = (path: string | null) => {
    if (!path || path === '/dev/null' || path === 'NULL') {
      return null;
    }
    let file = this._logFiles.get(path);
    if (!file) {
      file = new FakeLogFile();
      this._logFiles.set(path, file);
    }
    return file;
  };

  _generateLog = (process: IFakeProcess, time: number, isLive: boolean) => {
    const channel = this._random() < process.logErrorRatio ? 'err' : 'out';
    const text = generateLogEntry(process.logProfile, channel, this._random, time);
    this._writeLog(process, channel, text, time, isLive);
  };

  _writeLog = (
    process: IFakeProcess,
    channel: 'out' | 'err',
    text: string,
    time: number,
    isLive: boolean
  ) => {
    this._logFile(this._logPath(process, channel))?.append(text);
    // PM2 publishes what a process prints even when nothing is kept on disk.
    if (!isLive || !this._fields.isUp) {
      return;
    }
    const event: IPM2LogEvent = {
      type: channel,
      packet: {
        at: time,
        data: text,
        process: { name: process.name, pm_id: process.pmId, namespace: process.namespace },
      },
    };
    for (const connection of this._connections) {
      connection.onLog(event);
    }
  };
}
