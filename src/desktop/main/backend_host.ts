import type { UtilityProcess } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import libPath from 'node:path';
import { promisify } from 'node:util';

import type { IDesktopBackendOptions } from '../../backend/backend_settings';
import type { IDesktopUpdateState } from '../../shared/desktop_bridge';
import {
  IBackendMessage,
  IBackendRequest,
  IBackendStartupError,
  isBackendMessage,
} from '../shared/backend_protocol';
import type { IFileLog } from './desktop_log';

const STARTUP_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const KILL_WAIT_MS = 2_000;

/** A running backend, ready for the window. */
export interface IBackendRun {
  runId: string;
  baseURL: string;
  launchToken: string;
}

/** The backend could not start. `startupError` says why, safe to show. */
export class BackendStartError extends Error {
  readonly code = 'BACKEND_START_FAILED';

  constructor(readonly startupError: IBackendStartupError) {
    super(startupError.message);
    this.name = 'BackendStartError';
  }
}

export interface IBackendHostOptions {
  fork: (entryPath: string, options: { env: Record<string, string> }) => UtilityProcess;
  entryPath: string;
  environment: Record<string, string>;
  backendOptions: () => IDesktopBackendOptions;
  log: IFileLog;
  backendLog: IFileLog;
  /** A running backend exited without being asked to. */
  onUnexpectedExit: (code: number) => void;
  /** Fake mode: the backend's simulated update changed. */
  onFakeUpdate?: (state: IDesktopUpdateState) => void;
}

/** A process as `ps` reports it. */
export interface IProcessRow {
  pid: number;
  pgid: number;
  /** Start time in milliseconds, to the second. */
  startedAt: number;
  command: string;
}

/** An SSH process group the backend started, identified by its leader. */
export interface IOwnedGroup {
  pgid: number;
  leaderStartedAt: number;
}

/** `ps` reports elapsed time as [[dd-]hh:]mm:ss, on Linux and macOS alike. */
export function parseElapsed(value: string) {
  const [days, clock] = value.includes('-') ? value.split('-') : ['0', value];
  const seconds = clock
    .split(':')
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);
  return Number(days) * 86_400 + seconds;
}

export async function listProcesses(): Promise<IProcessRow[]> {
  const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pid=,pgid=,etime=,comm=']);
  const now = Date.now();
  return stdout
    .split('\n')
    .map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, pid, pgid, elapsed, command]) => ({
      pid: Number(pid),
      pgid: Number(pgid),
      startedAt: now - parseElapsed(elapsed) * 1000,
      command,
    }));
}

/** Start times come from `ps` in whole seconds, measured at different moments. */
const START_TOLERANCE_MS = 2_000;

/**
 * The live members of an owned SSH group. A group outlives its leader when a
 * ProxyCommand or other helper ignores SIGTERM, so membership, not the
 * leader, decides. A group whose leader PID now belongs to a newer process was
 * reused by someone else and is left alone.
 */
export function ownedGroupMembers(group: IOwnedGroup, rows: IProcessRow[]) {
  const leader = rows.find(row => row.pid === group.pgid);
  if (leader && Math.abs(leader.startedAt - group.leaderStartedAt) > START_TOLERANCE_MS) {
    return [];
  }
  return rows
    .filter(
      row => row.pgid === group.pgid && row.startedAt >= group.leaderStartedAt - START_TOLERANCE_MS
    )
    .map(row => row.pid);
}

/**
 * Starts and stops the backend the desktop app owns. Only this backend and the
 * SSH processes it reported are ever ended here; PM2 daemons and their apps
 * are never touched.
 */
export function createBackendHost(options: IBackendHostOptions) {
  const { log } = options;
  let child: UtilityProcess | null = null;
  let current: IBackendRun | null = null;
  let isStopping = false;
  /** Counts stops, so a restart decided before a stop began is dropped. */
  let stopGeneration = 0;
  /** SSH process groups the backend reported, by leader PID. Kept until they are empty. */
  const ownedGroups = new Map<number, IOwnedGroup>();
  let pendingRecords = Promise.resolve();

  /** Records newly reported SSH leaders: each leads its own process group. */
  const recordOwnedProcesses = async (pids: number[]) => {
    const rows = await listProcesses();
    for (const pid of pids) {
      const row = rows.find(candidate => candidate.pid === pid);
      if (!ownedGroups.has(pid) && row?.pgid === pid && libPath.basename(row.command) === 'ssh') {
        ownedGroups.set(pid, { pgid: pid, leaderStartedAt: row.startedAt });
      }
    }
    for (const group of ownedGroups.values()) {
      if (!ownedGroupMembers(group, rows).length) {
        ownedGroups.delete(group.pgid);
      }
    }
  };

  /** Signals every owned group that still has members, and returns how many do. */
  const signalOwnedGroups = async (signal: NodeJS.Signals | null) => {
    const rows = await listProcesses();
    let count = 0;
    for (const group of ownedGroups.values()) {
      if (!ownedGroupMembers(group, rows).length) {
        ownedGroups.delete(group.pgid);
        continue;
      }
      count++;
      if (signal) {
        try {
          process.kill(-group.pgid, signal);
        } catch {
          // The group ended in the meantime.
        }
      }
    }
    return count;
  };

  const waitForEmptyGroups = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await signalOwnedGroups(null))) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  };

  /**
   * Ends what is left of the SSH groups the backend started: SIGTERM, then
   * SIGKILL for members that ignore it. Resolves once they are gone or the
   * KILL has had time to land.
   */
  const runOwnedProcessCleanup = async () => {
    try {
      await pendingRecords;
      if (!ownedGroups.size || !(await signalOwnedGroups('SIGTERM'))) {
        return;
      }
      log.warn('Ending SSH processes left by the backend', { count: ownedGroups.size });
      if (!(await waitForEmptyGroups(1_000))) {
        await signalOwnedGroups('SIGKILL');
        await waitForEmptyGroups(1_000);
      }
    } catch (error) {
      log.error('Unable to end SSH processes left by the backend', { error });
    }
  };

  /**
   * Runs the cleanup after any that is still in progress, so every caller,
   * including a stop that comes while an exit is being cleaned up, waits for
   * all of it.
   */
  let cleanup = Promise.resolve();
  const endOwnedProcesses = () => {
    cleanup = cleanup.then(runOwnedProcessCleanup);
    return cleanup;
  };

  const waitForExit = (backend: UtilityProcess, timeoutMs: number) =>
    new Promise<boolean>(resolve => {
      if (backend.pid === undefined) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), timeoutMs);
      backend.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  /** Asks the backend to stop, then kills it if it does not exit in time. */
  const stopBackend = async (backend: UtilityProcess, timeoutMs: number) => {
    const runId = current?.runId;
    if (runId) {
      backend.postMessage({ type: 'stop', runId } satisfies IBackendRequest);
    } else {
      backend.kill();
    }
    if (await waitForExit(backend, timeoutMs)) {
      return;
    }
    log.warn('The backend did not stop in time; ending it');
    backend.kill();
    if (!(await waitForExit(backend, KILL_WAIT_MS)) && backend.pid) {
      log.error('The backend ignored SIGTERM; killing it', { pid: backend.pid });
      try {
        process.kill(backend.pid, 'SIGKILL');
      } catch {
        // It exited in the meantime.
      }
      await waitForExit(backend, KILL_WAIT_MS);
    }
  };
  return {
    get current() {
      return current;
    },

    get pid() {
      return child?.pid ?? null;
    },

    start: () =>
      new Promise<IBackendRun>((resolve, reject) => {
        if (child) {
          reject(new Error('The backend is already running.'));
          return;
        }
        const runId = randomUUID();
        isStopping = false;
        const backend = options.fork(options.entryPath, {
          env: options.environment,
        });
        child = backend;
        let isSettled = false;
        const settle = (error: Error | null, run?: IBackendRun) => {
          if (isSettled) {
            return;
          }
          isSettled = true;
          clearTimeout(timer);
          if (error) {
            reject(error);
          } else {
            resolve(run!);
          }
        };
        const timer = setTimeout(() => {
          settle(
            new BackendStartError({
              code: 'STARTUP_FAILED',
              message: 'The backend did not start in time.',
              path: null,
            })
          );
          backend.kill();
        }, STARTUP_TIMEOUT_MS);

        backend.stdout?.on('data', (chunk: Buffer) =>
          options.backendLog.raw(chunk.toString('utf8'))
        );
        backend.stderr?.on('data', (chunk: Buffer) =>
          options.backendLog.raw(chunk.toString('utf8'))
        );

        backend.on('message', (message: unknown) => {
          if (!isBackendMessage(message)) {
            log.warn('Ignored an unexpected message from the backend');
            return;
          }
          const typed = message as IBackendMessage;
          if (typed.type === 'fake-update') {
            if (child === backend) {
              options.onFakeUpdate?.(typed.state);
            }
            return;
          }
          if (typed.type === 'owned-processes') {
            pendingRecords = pendingRecords
              .then(() => recordOwnedProcesses(typed.pids))
              .catch(error => log.warn('Unable to record the backend SSH processes', { error }));
            return;
          }
          if (typed.runId !== runId) {
            log.warn('Ignored a message from another backend run');
            return;
          }
          if (typed.type === 'ready') {
            current = { runId, baseURL: typed.baseURL, launchToken: typed.launchToken };
            log.info('Backend ready', { baseURL: typed.baseURL, pid: backend.pid });
            settle(null, current);
          } else if (typed.type === 'failed') {
            log.error('Backend failed to start', { code: typed.error.code });
            settle(new BackendStartError(typed.error));
          }
        });

        backend.once('exit', code => {
          const wasRunning = current?.runId === runId;
          if (child === backend) {
            child = null;
            current = null;
          }
          log.info('Backend exited', { code });
          settle(
            new BackendStartError({
              code: 'STARTUP_FAILED',
              message: `The backend exited during startup (code ${code}).`,
              path: null,
            })
          );
          // A stop cleans up itself; an exit nobody asked for does it here,
          // before anything starts again.
          const generation = stopGeneration;
          if (wasRunning && !isStopping) {
            void endOwnedProcesses().then(() => {
              if (!isStopping && generation === stopGeneration) {
                options.onUnexpectedExit(code);
              }
            });
          } else if (!isStopping) {
            void endOwnedProcesses();
          }
        });

        backend.postMessage({
          type: 'start',
          runId,
          options: options.backendOptions(),
        } satisfies IBackendRequest);
      }),

    /** Fake mode: passes the user's action on the simulated update to the backend. */
    sendFakeUpdateAction: (action: 'check' | 'install') => {
      child?.postMessage({ type: 'fake-update-action', action } satisfies IBackendRequest);
    },

    /**
     * Stops the backend: it closes HTTP, streams, PM2 and SSH connections, then
     * exits. A backend that does not exit in time is killed with what it owns.
     */
    stop: async (timeoutMs = STOP_TIMEOUT_MS) => {
      // Before anything else, so a crash being cleaned up right now does not
      // start a new backend afterwards.
      isStopping = true;
      stopGeneration++;
      const backend = child;
      if (backend) {
        await stopBackend(backend, timeoutMs);
      }
      // Waits for a cleanup already running, and ends what an orderly exit left.
      await endOwnedProcesses();
    },
  };
}

export type IBackendHost = ReturnType<typeof createBackendHost>;
