import { randomUUID } from 'node:crypto';
import libOs from 'node:os';
import libPath from 'node:path';

import {
  IDaemonConfig,
  IDaemonInput,
  IDaemonSettings,
  IDaemonSummary,
  ILogView,
  IProcessAction,
  IProcessListResult,
  IProcessSummary,
} from '../../shared/contracts';
import { IBackendSettings, requestedDaemonInput, resolveLocalPath } from '../backend_settings';
import { IContainer, createDaemonContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IAppLifecycleMethods } from '../lib/app';

interface IDaemonRuntime {
  config: IDaemonConfig;
  container: IContainer;
  status: IDaemonSummary['status'];
  error: string | null;
  hostname: string | null;
  username: string | null;
  lastSeenAt: number | null;
  processes: IProcessSummary[];
  startPromise: Promise<void> | null;
  removeStatusListener: (() => void) | null;
  isRemoved: boolean;
}

export class DaemonNotFoundError extends Error {
  readonly code = 'DAEMON_NOT_FOUND';

  constructor(readonly daemonId: string) {
    super(`Daemon ${daemonId} was not found`);
    this.name = 'DaemonNotFoundError';
  }
}

export class DaemonUnavailableError extends Error {
  readonly code = 'DAEMON_UNAVAILABLE';

  constructor(readonly daemonId: string) {
    super('The selected PM2 daemon is not connected.');
    this.name = 'DaemonUnavailableError';
  }
}

export class InvalidDaemonError extends Error {
  readonly code = 'INVALID_DAEMON';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidDaemonError';
  }
}

export class DaemonConflictError extends Error {
  readonly code = 'DAEMON_ALREADY_CONFIGURED';

  constructor() {
    super('This PM2 daemon is already added.');
    this.name = 'DaemonConflictError';
  }
}

// A remote PM2 home ends up in an SSH stream-local forward ("local:remote"),
// so it cannot contain a colon. It is resolved on the server, so it must be
// absolute or start with ~.
const REMOTE_PM2_HOME_PATTERN = /^(~|~\/[^:\0]*|\/[^:\0]*)$/;

const DEFAULT_LOCAL_PM2_HOME = libPath.join(libOs.homedir(), '.pm2');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to connect to the PM2 daemon.';
}

function normalizeInput(input: IDaemonInput): IDaemonInput {
  const label = input.label?.trim();
  const labelPart = label ? { label } : {};
  if (input.kind === 'local') {
    return { kind: 'local', pm2Home: resolveLocalPath(input.pm2Home), ...labelPart };
  }
  const pm2Home = input.pm2Home?.trim().replace(/(.)\/+$/, '$1');
  if (pm2Home && !REMOTE_PM2_HOME_PATTERN.test(pm2Home)) {
    throw new InvalidDaemonError(
      'A remote PM2 home must be an absolute path or start with ~, and cannot contain ":".'
    );
  }
  return { kind: 'ssh', sshArgs: input.sshArgs, ...(pm2Home ? { pm2Home } : {}), ...labelPart };
}

function isSameDaemon(left: IDaemonInput, right: IDaemonInput) {
  if (left.kind === 'local' || right.kind === 'local') {
    return left.kind === right.kind && left.pm2Home === right.pm2Home;
  }
  return (
    JSON.stringify(left.sshArgs) === JSON.stringify(right.sshArgs) &&
    (left.pm2Home ?? null) === (right.pm2Home ?? null)
  );
}

function compactHomePath(path: string) {
  const home = libOs.homedir();
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function createDaemonManager({ settings, daemonStore, pm2HomeFinder, log }: IContainer) {
  const runtimes = new Map<string, IDaemonRuntime>();
  // Runtimes replaced by an edit finish disconnecting in the background.
  const retiringRuntimes = new Set<Promise<void>>();
  let mutationQueue = Promise.resolve();

  const serializeMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  const makeDaemonSettings = (config: IDaemonConfig): IBackendSettings => ({
    ...settings,
    pm2Home: config.pm2Home ?? null,
    sshArgs: config.kind === 'ssh' ? config.sshArgs : null,
    runtimeDaemonId: config.daemonId,
  });

  const createRuntime = (config: IDaemonConfig): IDaemonRuntime => ({
    config,
    container: createDaemonContainer(makeDaemonSettings(config)),
    status: 'offline',
    error: null,
    hostname: config.kind === 'local' ? libOs.hostname() : config.lastKnownHostname || null,
    username:
      config.kind === 'local' ? libOs.userInfo().username : config.lastKnownUsername || null,
    lastSeenAt: null,
    processes: [],
    startPromise: null,
    removeStatusListener: null,
    isRemoved: false,
  });

  const activeRuntimes = () => Array.from(runtimes.values()).filter(runtime => !runtime.isRemoved);

  const configuredDaemons = () => activeRuntimes().map(runtime => runtime.config);

  // Several PM2s can share a computer and user, so a PM2 home other than the
  // default is part of the name, like the path in an scp destination.
  const labelFor = ({ config, username, hostname }: IDaemonRuntime) => {
    if (config.label) {
      return config.label;
    }
    const machine =
      username && hostname
        ? `${username}@${hostname}`
        : config.kind === 'ssh'
          ? config.sshArgs.at(-1) || 'Remote host'
          : 'localhost';
    const pm2Home =
      config.kind === 'local'
        ? config.pm2Home === DEFAULT_LOCAL_PM2_HOME
          ? null
          : compactHomePath(config.pm2Home)
        : config.pm2Home;
    return pm2Home ? `${machine}:${pm2Home}` : machine;
  };

  const summaryFor = (runtime: IDaemonRuntime): IDaemonSummary => ({
    daemonId: runtime.config.daemonId,
    kind: runtime.config.kind,
    label: labelFor(runtime),
    hostname: runtime.hostname,
    username: runtime.username,
    status: runtime.status,
    error: runtime.error,
    lastSeenAt: runtime.lastSeenAt,
  });

  const settingsFor = (runtime: IDaemonRuntime): IDaemonSettings => ({
    ...summaryFor(runtime),
    config: runtime.config,
  });

  const persistLastKnownIdentity = async (runtime: IDaemonRuntime) => {
    await serializeMutation(async () => {
      if (
        runtime.isRemoved ||
        runtime.config.kind !== 'ssh' ||
        !runtime.hostname ||
        !runtime.username ||
        (runtime.config.lastKnownHostname === runtime.hostname &&
          runtime.config.lastKnownUsername === runtime.username)
      ) {
        return;
      }
      runtime.config = {
        ...runtime.config,
        lastKnownHostname: runtime.hostname,
        lastKnownUsername: runtime.username,
      };
      await daemonStore.save(configuredDaemons());
    });
  };

  const startRuntime = (runtime: IDaemonRuntime) => {
    if (runtime.startPromise || runtime.isRemoved) {
      return runtime.startPromise || Promise.resolve();
    }
    runtime.status = 'connecting';
    runtime.error = null;
    runtime.startPromise = runtime.container.app
      .start()
      .then(async () => {
        if (runtime.isRemoved) {
          await runtime.container.app.dispose();
          return;
        }
        const remoteInfo = runtime.container.sshConnection.remoteInfo;
        runtime.hostname = remoteInfo?.hostname || libOs.hostname();
        runtime.username = remoteInfo?.username || libOs.userInfo().username;
        runtime.status = 'online';
        runtime.error = null;
        runtime.lastSeenAt = Date.now();
        runtime.removeStatusListener = runtime.container.pm2Client.onDaemonStatus(connected => {
          runtime.status = connected ? 'online' : 'reconnecting';
          if (connected) {
            runtime.error = null;
            runtime.lastSeenAt = Date.now();
          }
        });
        await persistLastKnownIdentity(runtime).catch(error => {
          log.warn(
            { error, daemonId: runtime.config.daemonId },
            'Unable to persist daemon identity'
          );
        });
      })
      .catch(error => {
        runtime.status = 'error';
        runtime.error = errorMessage(error);
        log.warn(
          { error, daemonId: runtime.config.daemonId },
          'Unable to connect to the PM2 daemon'
        );
      })
      .finally(() => {
        runtime.startPromise = null;
      });
    return runtime.startPromise;
  };

  const disposeRuntime = async (runtime: IDaemonRuntime) => {
    runtime.removeStatusListener?.();
    runtime.removeStatusListener = null;
    await runtime.startPromise;
    await runtime.container.app.dispose();
  };

  const getRuntime = (daemonId: string) => {
    const runtime = runtimes.get(daemonId);
    if (!runtime || runtime.isRemoved) {
      throw new DaemonNotFoundError(daemonId);
    }
    return runtime;
  };

  const getOperationalRuntime = (daemonId: string) => {
    const runtime = getRuntime(daemonId);
    if (runtime.status !== 'online') {
      throw new DaemonUnavailableError(daemonId);
    }
    return runtime;
  };

  const refreshRuntime = async (runtime: IDaemonRuntime) => {
    const result = await runtime.container.processManager.list();
    runtime.hostname = result.hostname;
    runtime.username = result.username;
    runtime.processes = result.processes;
    runtime.status = 'online';
    runtime.error = null;
    runtime.lastSeenAt = Date.now();
  };

  const addRuntime = (config: IDaemonConfig) => {
    const runtime = createRuntime(config);
    runtimes.set(config.daemonId, runtime);
    void startRuntime(runtime);
    return runtime;
  };

  return new (class DaemonManager implements IAppLifecycleMethods {
    initialize = async () => {
      let daemons = await daemonStore.load();
      if (daemons === null) {
        // The first launch starts from the PM2 homes on this computer. The list
        // is saved even when empty, so daemons the user removes stay removed.
        daemons = (await pm2HomeFinder.find()).map(pm2Home => ({
          daemonId: randomUUID(),
          kind: 'local',
          pm2Home,
        }));
        await daemonStore.save(daemons);
        log.info({ count: daemons.length }, 'Added the detected local PM2 homes');
      }
      const requestedDaemon = requestedDaemonInput(settings);
      if (requestedDaemon) {
        const input = normalizeInput(requestedDaemon);
        if (!daemons.some(config => isSameDaemon(config, input))) {
          daemons = [...daemons, { ...input, daemonId: randomUUID() }];
          await daemonStore.save(daemons);
        }
      }
      for (const config of daemons) {
        runtimes.set(config.daemonId, createRuntime(config));
      }
    };

    start = async () => {
      for (const runtime of runtimes.values()) {
        void startRuntime(runtime);
      }
    };

    stop = async () => {
      await Promise.all(retiringRuntimes);
      await Promise.all(
        Array.from(runtimes.values(), async runtime => {
          runtime.removeStatusListener?.();
          runtime.removeStatusListener = null;
          await runtime.startPromise;
          await runtime.container.app.stop();
          runtime.status = 'offline';
        })
      );
    };

    dispose = async () => {
      await Promise.all(retiringRuntimes);
      await Promise.all(Array.from(runtimes.values(), disposeRuntime));
      runtimes.clear();
    };

    listDaemons = () => activeRuntimes().map(summaryFor);

    listSettings = () => activeRuntimes().map(settingsFor);

    listProcesses = async (): Promise<IProcessListResult> => {
      await Promise.all(
        Array.from(runtimes.values(), async runtime => {
          // A reconnecting daemon keeps its last known processes until the PM2
          // client reports the daemon again.
          if (runtime.container.app.state.stage !== 'active' || runtime.status === 'reconnecting') {
            return;
          }
          try {
            await refreshRuntime(runtime);
          } catch (error) {
            runtime.status = 'error';
            runtime.error = errorMessage(error);
          }
        })
      );
      return {
        daemons: this.listDaemons(),
        processes: Array.from(runtimes.values()).flatMap(runtime =>
          runtime.isRemoved ? [] : runtime.processes
        ),
      };
    };

    add = (input: IDaemonInput) =>
      serializeMutation(async () => {
        const normalized = normalizeInput(input);
        const duplicate = activeRuntimes().find(runtime =>
          isSameDaemon(runtime.config, normalized)
        );
        if (duplicate) {
          return { added: false, daemon: summaryFor(duplicate) };
        }
        const config: IDaemonConfig = { ...normalized, daemonId: randomUUID() };
        await daemonStore.save([...configuredDaemons(), config]);
        return { added: true, daemon: summaryFor(addRuntime(config)) };
      });

    remove = async (daemonId: string) => {
      const runtime = await serializeMutation(async () => {
        const selectedRuntime = getRuntime(daemonId);
        selectedRuntime.isRemoved = true;
        await daemonStore.save(configuredDaemons());
        return selectedRuntime;
      });
      await disposeRuntime(runtime);
      runtimes.delete(daemonId);
      log.info({ daemonId }, 'PM2 daemon removed from Captain');
      return { removed: true };
    };

    update = (daemonId: string, input: IDaemonInput) =>
      serializeMutation(async () => {
        const current = getRuntime(daemonId);
        const normalized = normalizeInput(input);
        if (normalized.kind !== current.config.kind) {
          throw new InvalidDaemonError('A daemon cannot switch between local and SSH.');
        }
        if (
          activeRuntimes().some(
            other => other !== current && isSameDaemon(other.config, normalized)
          )
        ) {
          throw new DaemonConflictError();
        }
        const isSameConnection = isSameDaemon(current.config, normalized);
        // The remembered identity describes the previous destination.
        const previous = isSameConnection && current.config.kind === 'ssh' ? current.config : null;
        const config: IDaemonConfig = {
          ...normalized,
          daemonId,
          ...(previous?.lastKnownHostname && previous.lastKnownUsername
            ? {
                lastKnownHostname: previous.lastKnownHostname,
                lastKnownUsername: previous.lastKnownUsername,
              }
            : {}),
        };
        await daemonStore.save(
          configuredDaemons().map(existing => (existing.daemonId === daemonId ? config : existing))
        );
        log.info({ daemonId, isSameConnection }, 'PM2 daemon updated');
        if (isSameConnection) {
          current.config = config;
          return settingsFor(current);
        }

        // A new location means a new connection. The replacement keeps the daemon
        // ID and list position, so open pages and the selection stay valid.
        current.isRemoved = true;
        const replacement = createRuntime(config);
        runtimes.set(daemonId, replacement);
        void startRuntime(replacement);
        // The old connection may still be timing out; do not make the edit wait.
        const retirement = disposeRuntime(current)
          .catch(error => {
            log.warn({ error, daemonId }, 'Unable to disconnect the replaced PM2 daemon');
          })
          .finally(() => retiringRuntimes.delete(retirement));
        retiringRuntimes.add(retirement);
        return settingsFor(replacement);
      });

    retry = async (daemonId: string) => {
      const runtime = getRuntime(daemonId);
      if (runtime.status === 'online' || runtime.status === 'connecting') {
        return summaryFor(runtime);
      }
      if (runtime.container.app.state.stage === 'active') {
        try {
          await refreshRuntime(runtime);
        } catch (error) {
          runtime.status = 'error';
          runtime.error = errorMessage(error);
        }
      } else {
        await startRuntime(runtime);
      }
      return summaryFor(runtime);
    };

    detail = (daemonId: string, pmId: number, includeEnvironment = false) =>
      getOperationalRuntime(daemonId).container.processManager.detail(pmId, includeEnvironment);

    action = (daemonId: string, pmId: number, action: IProcessAction) =>
      getOperationalRuntime(daemonId).container.processManager.action(pmId, action);

    logPage = (
      daemonId: string,
      pmId: number,
      view: ILogView,
      cursor?: string | null,
      limit?: number
    ) => getOperationalRuntime(daemonId).container.logManager.page(pmId, view, cursor, limit);

    logStream = (daemonId: string, pmId: number, view: ILogView) =>
      getOperationalRuntime(daemonId).container.logManager.stream(pmId, view);
  })();
}

export default define({
  createDaemonManager,
});
