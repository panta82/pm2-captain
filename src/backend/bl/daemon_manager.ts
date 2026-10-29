import { observable } from '@trpc/server/observable';
import { randomUUID } from 'node:crypto';
import libOs from 'node:os';
import libPath from 'node:path';

import {
  IDaemonConfig,
  IDaemonInput,
  IDaemonSettings,
  IDaemonSummary,
  ILogStreamEvent,
  ILogView,
  IProcessAction,
  IProcessListResult,
  IProcessSummary,
} from '../../shared/contracts';
import { IBackendSettings, requestedDaemonInput, resolveLocalPath } from '../backend_settings';
import { IContainer, createDaemonContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IAppLifecycleMethods } from '../lib/app';
import { DaemonRegistryError, daemonLocationKey } from '../lib/daemon_store';

interface IDaemonRuntime {
  config: IDaemonConfig;
  /**
   * Identifies this connection. A daemon whose location changes gets a new
   * runtime and a new ID, so requests prepared for the old location fail.
   */
  connectionId: string;
  container: IContainer;
  status: IDaemonSummary['status'];
  error: string | null;
  hostname: string | null;
  username: string | null;
  lastSeenAt: number | null;
  processes: IProcessSummary[];
  startPromise: Promise<void> | null;
  removeStatusListener: (() => void) | null;
  /** Ends the log streams of this connection when it is retired. */
  streamClosers: Set<() => void>;
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

/** The daemon was changed elsewhere since the form that edits it was opened. */
export class DaemonChangedError extends Error {
  readonly code = 'DAEMON_CHANGED';

  constructor(readonly daemonId: string) {
    super(
      'This daemon was changed elsewhere since you opened it. Your edits are kept; reload the daemon to see the saved version.'
    );
    this.name = 'DaemonChangedError';
  }
}

/** The request was prepared for a connection that has since been replaced or removed. */
export class StaleDaemonConnectionError extends Error {
  readonly code = 'DAEMON_CONNECTION_REPLACED';

  constructor(readonly daemonId: string) {
    super(
      'This daemon was reconfigured. Nothing was sent to PM2; check the process and try again.'
    );
    this.name = 'StaleDaemonConnectionError';
  }
}

/** A warning about the registry file that leaves the last working daemons in use. */
export interface IDaemonRegistryWarning {
  path: string;
  message: string;
}

// A remote PM2 home ends up in an SSH stream-local forward ("local:remote"),
// so it cannot contain a colon. It is resolved on the server, so it must be
// absolute or start with ~.
const REMOTE_PM2_HOME_PATTERN = /^(~|~\/[^:\0]*|\/[^:\0]*)$/;

const DEFAULT_LOCAL_PM2_HOME = libPath.join(libOs.homedir(), '.pm2');

// The status listener changes the status while a call is pending. A plain
// comparison would let the compiler assume it stays what it was before the call.
function isReconnecting(runtime: IDaemonRuntime) {
  return runtime.status === 'reconnecting';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to connect to the PM2 daemon.';
}

function normalizeInput(input: IDaemonInput): IDaemonInput {
  const label = input.label?.trim();
  const appearance = {
    ...(label ? { label } : {}),
    ...(input.color ? { color: input.color } : {}),
  };
  if (input.kind === 'local') {
    return { kind: 'local', pm2Home: resolveLocalPath(input.pm2Home), ...appearance };
  }
  const pm2Home = input.pm2Home?.trim().replace(/(.)\/+$/, '$1');
  if (pm2Home && !REMOTE_PM2_HOME_PATTERN.test(pm2Home)) {
    throw new InvalidDaemonError(
      'A remote PM2 home must be an absolute path or start with ~, and cannot contain ":".'
    );
  }
  return { kind: 'ssh', sshArgs: input.sshArgs, ...(pm2Home ? { pm2Home } : {}), ...appearance };
}

function isSameDaemon(left: IDaemonInput, right: IDaemonInput) {
  return daemonLocationKey(left) === daemonLocationKey(right);
}

/** The fields a user edits. Remembered host metadata is not one of them. */
function editableFields(daemon: IDaemonInput | IDaemonConfig): string {
  return JSON.stringify([
    daemon.kind,
    daemon.kind === 'ssh' ? daemon.sshArgs : null,
    daemon.pm2Home ?? null,
    daemon.label ?? null,
    daemon.color ?? null,
  ]);
}

function compactHomePath(path: string) {
  const home = libOs.homedir();
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function createDaemonManager({
  settings,
  daemonStore,
  pm2HomeFinder,
  log,
  container: appContainer,
}: IContainer) {
  // In registry order. Retired runtimes leave the map at once.
  const runtimes = new Map<string, IDaemonRuntime>();
  // Runtimes that were replaced or removed finish disconnecting in the background.
  const retiringRuntimes = new Set<Promise<void>>();
  let mutationQueue = Promise.resolve();
  let isStarted = false;
  let stopWatching: (() => void) | null = null;
  let registryWarning: IDaemonRegistryWarning | null = null;

  const serializeMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  const makeDaemonSettings = (config: IDaemonConfig, connectionId: string): IBackendSettings => ({
    ...settings,
    pm2Home: config.pm2Home ?? null,
    sshArgs: config.kind === 'ssh' ? config.sshArgs : null,
    runtimeDaemonId: config.daemonId,
    runtimeConnectionId: connectionId,
  });

  const createRuntime = (config: IDaemonConfig): IDaemonRuntime => {
    const connectionId = randomUUID();
    const container = createDaemonContainer(makeDaemonSettings(config, connectionId), appContainer);
    // A local daemon is known before it connects. A remote one shows what was
    // remembered from its last connection.
    const identity = container.pm2Daemon.identity;
    const remembered = config.kind === 'ssh' ? config : null;
    return {
      config,
      connectionId,
      container,
      status: 'offline',
      error: null,
      hostname: identity?.hostname || remembered?.lastKnownHostname || null,
      username: identity?.username || remembered?.lastKnownUsername || null,
      lastSeenAt: null,
      processes: [],
      startPromise: null,
      removeStatusListener: null,
      streamClosers: new Set(),
      isRemoved: false,
    };
  };

  const activeRuntimes = () => Array.from(runtimes.values());

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
    connectionId: runtime.connectionId,
    kind: runtime.config.kind,
    label: labelFor(runtime),
    color: runtime.config.color ?? null,
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

  const disposeRuntime = async (runtime: IDaemonRuntime) => {
    runtime.removeStatusListener?.();
    runtime.removeStatusListener = null;
    for (const close of runtime.streamClosers) {
      close();
    }
    // A connection attempt still in progress would otherwise hold the disposal
    // until its SSH timeout. Fake daemons have no SSH connection.
    if (runtime.startPromise && runtime.container.identifiers.includes('sshConnection')) {
      await runtime.container.sshConnection.abort();
    }
    await runtime.startPromise;
    await runtime.container.app.dispose();
  };

  /** Takes a runtime out of service. Resolves once it has disconnected. */
  const retireRuntime = (runtime: IDaemonRuntime) => {
    runtime.isRemoved = true;
    const daemonId = runtime.config.daemonId;
    const retirement: Promise<void> = disposeRuntime(runtime)
      .catch(error => {
        log.warn({ error, daemonId }, 'Unable to disconnect a replaced or removed PM2 daemon');
      })
      .finally(() => retiringRuntimes.delete(retirement));
    retiringRuntimes.add(retirement);
    return retirement;
  };

  /**
   * Makes the runtimes match a validated list. Label and color edits and
   * reordering keep connections; a new location is a new connection. Runs in
   * the mutation queue. Resolves to the retirements it started.
   */
  const reconcile = (configs: IDaemonConfig[]) => {
    const previous = new Map(runtimes);
    const retirements: Promise<void>[] = [];
    const started: IDaemonRuntime[] = [];
    runtimes.clear();
    for (const config of configs) {
      const current = previous.get(config.daemonId);
      previous.delete(config.daemonId);
      if (current && isSameDaemon(current.config, config)) {
        current.config = config;
        runtimes.set(config.daemonId, current);
        continue;
      }
      if (current) {
        retirements.push(retireRuntime(current));
        log.info({ daemonId: config.daemonId }, 'PM2 daemon location changed; reconnecting');
      }
      const runtime = createRuntime(config);
      runtimes.set(config.daemonId, runtime);
      started.push(runtime);
    }
    for (const removed of previous.values()) {
      retirements.push(retireRuntime(removed));
      log.info({ daemonId: removed.config.daemonId }, 'PM2 daemon removed from Captain');
    }
    if (isStarted) {
      for (const runtime of started) {
        void startRuntime(runtime);
      }
    }
    return retirements;
  };

  /**
   * Runs one change against the newest registry on disk and applies the result
   * here. After startup the file has to hold a valid list: a missing or broken
   * file is never replaced with what this process remembers.
   */
  const mutateRegistry = async (
    operation: (current: IDaemonConfig[]) => IDaemonConfig[] | undefined
  ) => {
    const result = await daemonStore.mutate(current => {
      if (current === null) {
        throw new DaemonRegistryError(
          daemonStore.path,
          'The daemon list is missing. Restore the file or restart Captain to detect local PM2 daemons.'
        );
      }
      return operation(current);
    });
    registryWarning = null;
    return reconcile(result ?? []);
  };

  const persistLastKnownIdentity = (runtime: IDaemonRuntime) =>
    serializeMutation(async () => {
      if (runtime.isRemoved || runtime.config.kind !== 'ssh') {
        return;
      }
      const { hostname, username } = runtime;
      const remembered = runtime.config;
      // Unchanged identities need no locked save.
      if (
        !hostname ||
        !username ||
        (remembered.lastKnownHostname === hostname && remembered.lastKnownUsername === username)
      ) {
        return;
      }
      await mutateRegistry(current => {
        const entry = current.find(config => config.daemonId === runtime.config.daemonId);
        // A retiring connection must not resurrect a removed daemon or describe
        // a location the daemon no longer has.
        if (
          runtime.isRemoved ||
          entry?.kind !== 'ssh' ||
          !isSameDaemon(entry, runtime.config) ||
          (entry.lastKnownHostname === hostname && entry.lastKnownUsername === username)
        ) {
          return undefined;
        }
        return current.map(config =>
          config === entry
            ? { ...entry, lastKnownHostname: hostname, lastKnownUsername: username }
            : config
        );
      });
    });

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
          return;
        }
        const identity = runtime.container.pm2Daemon.identity;
        if (identity) {
          runtime.hostname = identity.hostname;
          runtime.username = identity.username;
        }
        runtime.status = 'online';
        runtime.error = null;
        runtime.lastSeenAt = Date.now();
        runtime.removeStatusListener = runtime.container.pm2Daemon.onDaemonStatus(connected => {
          runtime.status = connected ? 'online' : 'reconnecting';
          if (connected) {
            runtime.error = null;
            runtime.lastSeenAt = Date.now();
          }
        });
        // Not awaited: the save waits for the mutation queue, and a mutation
        // that retires this runtime waits for this start to finish.
        void persistLastKnownIdentity(runtime).catch(error => {
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

  const getRuntime = (daemonId: string) => {
    const runtime = runtimes.get(daemonId);
    if (!runtime) {
      throw new DaemonNotFoundError(daemonId);
    }
    return runtime;
  };

  const assertConnection = (runtime: IDaemonRuntime, connectionId: string | undefined) => {
    if (
      connectionId !== undefined &&
      (runtime.isRemoved || runtime.connectionId !== connectionId)
    ) {
      throw new StaleDaemonConnectionError(runtime.config.daemonId);
    }
  };

  const getOperationalRuntime = (daemonId: string, connectionId?: string) => {
    const runtime = runtimes.get(daemonId);
    if (!runtime) {
      // A request for a known connection of a removed daemon is stale, not unknown.
      if (connectionId !== undefined) {
        throw new StaleDaemonConnectionError(daemonId);
      }
      throw new DaemonNotFoundError(daemonId);
    }
    assertConnection(runtime, connectionId);
    if (runtime.status !== 'online') {
      throw new DaemonUnavailableError(daemonId);
    }
    return runtime;
  };

  const refreshRuntime = async (runtime: IDaemonRuntime) => {
    const result = await runtime.container.processManager.list();
    if (runtime.isRemoved) {
      return;
    }
    runtime.hostname = result.hostname;
    runtime.username = result.username;
    runtime.processes = result.processes;
    runtime.status = 'online';
    runtime.error = null;
    runtime.lastSeenAt = Date.now();
  };

  /** Rereads the registry after a change on disk, keeping the last good list on errors. */
  const reload = () =>
    serializeMutation(async () => {
      if (!isStarted) {
        return;
      }
      let configs: IDaemonConfig[] | null;
      try {
        configs = await daemonStore.load();
      } catch (error) {
        const message =
          error instanceof DaemonRegistryError
            ? error.message
            : `${daemonStore.path}: ${errorMessage(error)}`;
        if (registryWarning?.message !== message) {
          log.warn(
            { path: daemonStore.path },
            'The daemon registry cannot be used; keeping the last working daemons'
          );
        }
        registryWarning = { path: daemonStore.path, message };
        return;
      }
      if (configs === null) {
        registryWarning = {
          path: daemonStore.path,
          message: `${daemonStore.path}: The daemon list is missing. Captain keeps the last working daemons.`,
        };
        return;
      }
      registryWarning = null;
      void Promise.all(reconcile(configs));
    });

  return new (class DaemonManager implements IAppLifecycleMethods {
    initialize = async () => {
      registryWarning = null;
      // Invalid content fails startup: there is no working list to fall back to.
      let daemons = await daemonStore.load();
      if (daemons === null) {
        // The first launch starts from the PM2 homes on this computer. The list
        // is saved even when empty, so daemons the user removes stay removed.
        const detected = (await pm2HomeFinder.find()).map((pm2Home): IDaemonConfig => ({
          daemonId: randomUUID(),
          kind: 'local',
          pm2Home,
        }));
        let isSaved = false;
        // Another Captain may have set the list up in the meantime; that list wins.
        daemons = await daemonStore.mutate(current => {
          if (current !== null) {
            return undefined;
          }
          isSaved = true;
          return detected;
        });
        if (isSaved) {
          log.info({ count: detected.length }, 'Added the detected local PM2 homes');
        }
      }
      const requestedDaemon = requestedDaemonInput(settings);
      if (requestedDaemon) {
        const input = normalizeInput(requestedDaemon);
        daemons = await daemonStore.mutate(current =>
          current?.some(config => isSameDaemon(config, input))
            ? undefined
            : [...(current ?? []), { ...input, daemonId: randomUUID() } as IDaemonConfig]
        );
      }
      runtimes.clear();
      for (const config of daemons ?? []) {
        runtimes.set(config.daemonId, createRuntime(config));
      }
    };

    start = async () => {
      isStarted = true;
      for (const runtime of runtimes.values()) {
        void startRuntime(runtime);
      }
      // Watch first, then reread, so an edit between the initial read and the
      // watch is not missed.
      stopWatching = await daemonStore.watch(() => void reload());
      void reload();
    };

    stop = async () => {
      isStarted = false;
      stopWatching?.();
      stopWatching = null;
      await mutationQueue;
      await Promise.all(retiringRuntimes);
      await Promise.all(
        Array.from(runtimes.values(), async runtime => {
          runtime.removeStatusListener?.();
          runtime.removeStatusListener = null;
          for (const close of runtime.streamClosers) {
            close();
          }
          if (runtime.startPromise && runtime.container.identifiers.includes('sshConnection')) {
            await runtime.container.sshConnection.abort();
          }
          await runtime.startPromise;
          await runtime.container.app.stop();
          runtime.status = 'offline';
        })
      );
    };

    dispose = async () => {
      isStarted = false;
      stopWatching?.();
      stopWatching = null;
      await mutationQueue;
      await Promise.all(retiringRuntimes);
      await Promise.all(Array.from(runtimes.values(), disposeRuntime));
      runtimes.clear();
    };

    get registryWarning() {
      return registryWarning;
    }

    /** Rereads the registry now, as a file change would. */
    reload = reload;

    listDaemons = () => activeRuntimes().map(summaryFor);

    listSettings = () => activeRuntimes().map(settingsFor);

    listProcesses = async (): Promise<IProcessListResult> => {
      const listed = activeRuntimes();
      await Promise.all(
        listed.map(async runtime => {
          // A reconnecting daemon keeps its last known processes until the PM2
          // client reports the daemon again.
          if (runtime.container.app.state.stage !== 'active' || isReconnecting(runtime)) {
            return;
          }
          try {
            await refreshRuntime(runtime);
          } catch (error) {
            // The PM2 client fails its pending calls when it loses the daemon,
            // right after reporting the loss. That report stands.
            if (isReconnecting(runtime) || runtime.isRemoved) {
              return;
            }
            runtime.status = 'error';
            runtime.error = errorMessage(error);
          }
        })
      );
      // A runtime retired while the list was refreshing is not shown.
      const current = activeRuntimes();
      return {
        daemons: current.map(summaryFor),
        processes: current.flatMap(runtime => runtime.processes),
        registryWarning: registryWarning?.message ?? null,
      };
    };

    add = (input: IDaemonInput) =>
      serializeMutation(async () => {
        const normalized = normalizeInput(input);
        let addedId: string | null = null;
        let duplicateId: string | null = null;
        await mutateRegistry(current => {
          const duplicate = current.find(config => isSameDaemon(config, normalized));
          if (duplicate) {
            duplicateId = duplicate.daemonId;
            return undefined;
          }
          const config = { ...normalized, daemonId: randomUUID() } as IDaemonConfig;
          addedId = config.daemonId;
          return [...current, config];
        });
        if (addedId) {
          log.info({ daemonId: addedId }, 'PM2 daemon added');
        }
        return {
          added: addedId !== null,
          daemon: summaryFor(getRuntime((addedId ?? duplicateId)!)),
        };
      });

    /**
     * Removes a daemon. `expected` holds the fields the user saw; a daemon that
     * changed since then is not removed.
     */
    remove = async (daemonId: string, expected: IDaemonInput) => {
      const retirements = await serializeMutation(() =>
        mutateRegistry(current => {
          const entry = current.find(config => config.daemonId === daemonId);
          if (!entry) {
            throw new DaemonNotFoundError(daemonId);
          }
          if (editableFields(entry) !== editableFields(expected)) {
            throw new DaemonChangedError(daemonId);
          }
          return current.filter(config => config !== entry);
        })
      );
      await Promise.all(retirements);
      return { removed: true };
    };

    /**
     * Saves an edit made from the daemon form. `expected` holds the fields the
     * form was opened with; a daemon that changed since then is not overwritten.
     */
    update = (daemonId: string, input: IDaemonInput, expected: IDaemonInput) =>
      serializeMutation(async () => {
        const normalized = normalizeInput(input);
        let isSameConnection = false;
        await mutateRegistry(current => {
          const entry = current.find(config => config.daemonId === daemonId);
          if (!entry) {
            throw new DaemonNotFoundError(daemonId);
          }
          if (editableFields(entry) !== editableFields(expected)) {
            throw new DaemonChangedError(daemonId);
          }
          if (normalized.kind !== entry.kind) {
            throw new InvalidDaemonError('A daemon cannot switch between local and SSH.');
          }
          if (current.some(other => other !== entry && isSameDaemon(other, normalized))) {
            throw new DaemonConflictError();
          }
          isSameConnection = isSameDaemon(entry, normalized);
          // The remembered identity describes the previous destination.
          const previous = isSameConnection && entry.kind === 'ssh' ? entry : null;
          const config = {
            ...normalized,
            daemonId,
            ...(previous?.lastKnownHostname && previous.lastKnownUsername
              ? {
                  lastKnownHostname: previous.lastKnownHostname,
                  lastKnownUsername: previous.lastKnownUsername,
                }
              : {}),
          } as IDaemonConfig;
          return current.map(existing => (existing === entry ? config : existing));
        });
        log.info({ daemonId, isSameConnection }, 'PM2 daemon updated');
        // The replacement keeps the daemon ID and list position, so open pages
        // and the selection stay valid; its connection ID is new.
        return settingsFor(getRuntime(daemonId));
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

    detail = (daemonId: string, pmId: number, includeEnvironment = false, connectionId?: string) =>
      getOperationalRuntime(daemonId, connectionId).container.processManager.detail(
        pmId,
        includeEnvironment
      );

    /**
     * Runs a lifecycle action on the connection the request was prepared for.
     * It is checked again when the action's turn in the queue comes; an action
     * that was already sent is never repeated.
     */
    action = (daemonId: string, connectionId: string, pmId: number, action: IProcessAction) => {
      const runtime = getOperationalRuntime(daemonId, connectionId);
      return runtime.container.processManager.action(pmId, action, () => {
        if (runtimes.get(daemonId) !== runtime) {
          throw new StaleDaemonConnectionError(daemonId);
        }
        assertConnection(runtime, connectionId);
      });
    };

    logPage = (
      daemonId: string,
      pmId: number,
      view: ILogView,
      cursor?: string | null,
      limit?: number,
      connectionId?: string
    ) =>
      getOperationalRuntime(daemonId, connectionId).container.logManager.page(
        pmId,
        view,
        cursor,
        limit
      );

    /** A log stream that ends when its connection is replaced or removed. */
    logStream = (daemonId: string, pmId: number, view: ILogView, connectionId?: string) => {
      const runtime = getOperationalRuntime(daemonId, connectionId);
      const stream = runtime.container.logManager.stream(pmId, view);
      return observable<ILogStreamEvent>(emit => {
        const close = () => emit.error(new StaleDaemonConnectionError(daemonId));
        runtime.streamClosers.add(close);
        const subscription = stream.subscribe(emit);
        return () => {
          runtime.streamClosers.delete(close);
          subscription.unsubscribe();
        };
      });
    };
  })();
}

export default define({
  createDaemonManager,
});
