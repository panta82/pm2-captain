import type { IDaemonConfig } from '../../shared/contracts';
import { PACKAGE_VERSION, resolveLocalPath } from '../backend_settings';
import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IAppLifecycleMethods } from '../lib/app';
import { Pm2DaemonUnavailableError } from '../lib/pm2_client';
import { IPm2DaemonIdentity } from '../lib/pm2_daemon';
import { SshConnectionError } from '../lib/ssh_connection';
import {
  FakeRegistryUnavailableError,
  IFakeCommand,
  InvalidFakeCommandError,
} from './fake_commands';
import {
  FAKE_LOCAL_IDENTITY,
  FakeDaemon,
  FakeTargetNotFoundError,
  IFakeConnectionHandlers,
  IFakeLocation,
  fakeLocationKey,
} from './fake_daemon';
import { createRandom } from './fake_logs';
import { loadFakeScenario } from './fake_scenario';
import { createFakeUpdates } from './fake_updates';

const TICK_INTERVAL_MS = 100;

/** How the simulated daemon registry file fails, as the real store reports it. */
export type IFakeRegistryFailure = 'invalid' | 'missing' | 'unreadable';

/** Captain's stored daemon list in fake mode. It lives in memory only. */
export interface IFakeRegistry {
  /** Null: never set up, as on a first launch. */
  daemons: IDaemonConfig[] | null;
  failure: IFakeRegistryFailure | null;
}

/**
 * The PM2 daemons that exist in fake mode: everything Captain would otherwise
 * find on this computer and on the servers it reaches.
 */
export function createFakeWorld({ settings, log }: IContainer) {
  let daemons = new Map<string, FakeDaemon>();
  /** The name or path of the loaded scenario. Null for one that was sent as data. */
  let scenarioName: string | null = null;
  let isFirstLaunch = false;
  /** Counts resets, so whoever remembers something about the world can tell it was replaced. */
  let generation = 0;
  let timer: NodeJS.Timeout | null = null;
  let lastTickAt = 0;
  let registry: IFakeRegistry = { daemons: null, failure: null };
  const registryListeners = new Set<() => void>();
  const updates = createFakeUpdates(PACKAGE_VERSION);

  /** Tells the watcher, as a change of the registry file would. */
  const changeRegistry = (next: IFakeRegistry) => {
    registry = next;
    for (const listener of registryListeners) {
      listener();
    }
  };

  /** The stored list, for a command that edits it. A broken file cannot be edited. */
  const editableRegistry = () => {
    if (registry.failure || !registry.daemons) {
      throw new FakeRegistryUnavailableError();
    }
    return registry.daemons;
  };

  const storedEntry = (daemons: IDaemonConfig[], key: string) => {
    const daemonId = getDaemon(key).daemonId;
    const entry = daemons.find(config => config.daemonId === daemonId);
    if (!entry) {
      throw new FakeTargetNotFoundError(`The fake daemon "${key}" is not in Captain's list.`);
    }
    return entry;
  };

  const getDaemon = (key: string) => {
    const daemon = daemons.get(key);
    if (!daemon) {
      throw new FakeTargetNotFoundError(`There is no fake daemon "${key}".`);
    }
    return daemon;
  };

  const daemonAt = (location: IFakeLocation) => {
    const locationKey = fakeLocationKey(location);
    return Array.from(daemons.values()).find(
      daemon => fakeLocationKey(daemon.location) === locationKey
    );
  };

  return new (class FakeWorld implements IAppLifecycleMethods {
    get generation() {
      return generation;
    }

    /** The simulated desktop update. */
    readonly updates = updates;

    initialize = async () => {
      await this.reset();
    };

    start = async () => {
      lastTickAt = Date.now();
      timer = setInterval(() => {
        const now = Date.now();
        for (const daemon of daemons.values()) {
          daemon.tick(now - lastTickAt, now);
        }
        lastTickAt = now;
      }, TICK_INTERVAL_MS);
      timer.unref();
    };

    stop = async () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    /** Replaces every daemon. Without a scenario, the one Captain was started with is loaded. */
    reset = async (source: unknown = settings.fake?.scenario) => {
      const scenario = await loadFakeScenario(source);
      const random = createRandom(scenario.seed ?? 1);
      const nextDaemons = new Map<string, FakeDaemon>();
      for (const input of scenario.daemons) {
        nextDaemons.set(input.key, new FakeDaemon(input, random));
      }
      daemons = nextDaemons;
      scenarioName = typeof source === 'string' ? source : null;
      isFirstLaunch = scenario.isFirstLaunch ?? false;
      generation++;
      // Captain reloads its list after a reset; the registry starts as the scenario defines it.
      registry = { daemons: this.registeredDaemons(), failure: null };
      updates.reset();
      log.info({ daemons: daemons.size }, 'Fake world loaded');
    };

    /** The daemon list Captain starts with. Null means it was never set up. */
    registeredDaemons = (): IDaemonConfig[] | null =>
      isFirstLaunch
        ? null
        : Array.from(daemons.values())
            .filter(daemon => daemon.isRegistered)
            .map(daemon => daemon.config);

    /** Captain's stored daemon list, as the fake daemon store reads it. */
    get registry(): IFakeRegistry {
      return registry;
    }

    /** Captain saved its list. */
    saveRegistry = (daemons: IDaemonConfig[]) => {
      changeRegistry({ daemons, failure: null });
    };

    /** Calls `listener` whenever the stored list changes, as the registry watcher would. */
    onRegistryChange = (listener: () => void) => {
      registryListeners.add(listener);
      return () => {
        registryListeners.delete(listener);
      };
    };

    /** The local PM2 homes a first launch would detect. */
    detectableHomes = () =>
      Array.from(daemons.values()).flatMap(daemon =>
        daemon.location.kind === 'local' && daemon.isUp ? [daemon.location.pm2Home] : []
      );

    /**
     * What is known about a location before connecting: a local daemon runs as
     * the current user, a remote one is unknown until it answers.
     */
    identityAt = (location: IFakeLocation): IPm2DaemonIdentity | null =>
      location.kind === 'local' ? (daemonAt(location)?.identity ?? FAKE_LOCAL_IDENTITY) : null;

    /** Connects to the PM2 daemon at a location, or fails the way a real attempt would. */
    connect = async (location: IFakeLocation, handlers: IFakeConnectionHandlers) => {
      const daemon = daemonAt(location);
      if (!daemon) {
        throw location.kind === 'ssh'
          ? new SshConnectionError(
              `ssh: Could not resolve hostname ${location.sshArgs.at(-1)}: Name or service not known`
            )
          : new Pm2DaemonUnavailableError(`PM2 is not running in ${location.pm2Home}.`);
      }
      await daemon.connect(handlers);
      return daemon;
    };

    /** Applies any command except `world.reset`, which also involves Captain's daemon list. */
    apply = (command: Exclude<IFakeCommand, { type: 'world.reset' }>) => {
      if (command.type === 'registry.fail') {
        changeRegistry({ ...registry, failure: command.reason });
        return;
      }
      if (command.type === 'registry.recover') {
        changeRegistry({ ...registry, failure: null });
        return;
      }
      if (command.type === 'registry.edit') {
        const daemons = editableRegistry();
        const entry = storedEntry(daemons, command.daemon);
        if (command.label === undefined && command.pm2Home === undefined) {
          throw new InvalidFakeCommandError('registry.edit needs a label or a pm2Home.');
        }
        const { label: _label, ...unlabeled } = entry;
        const label = command.label === undefined ? entry.label : (command.label ?? undefined);
        const pm2Home =
          command.pm2Home === undefined
            ? entry.pm2Home
            : entry.kind === 'local'
              ? resolveLocalPath(command.pm2Home)
              : command.pm2Home;
        const edited = { ...unlabeled, pm2Home, ...(label ? { label } : {}) } as IDaemonConfig;
        changeRegistry({
          ...registry,
          daemons: daemons.map(config => (config === entry ? edited : config)),
        });
        return;
      }
      if (command.type === 'registry.remove') {
        const daemons = editableRegistry();
        const entry = storedEntry(daemons, command.daemon);
        changeRegistry({ ...registry, daemons: daemons.filter(config => config !== entry) });
        return;
      }
      if (command.type === 'registry.add') {
        const daemons = editableRegistry();
        const config = getDaemon(command.daemon).config;
        if (!daemons.some(existing => existing.daemonId === config.daemonId)) {
          changeRegistry({ ...registry, daemons: [...daemons, config] });
        }
        return;
      }
      if (command.type === 'update.set') {
        const { type: _type, ...fields } = command;
        updates.set(fields);
        return;
      }
      if (command.type === 'update.install-outcome') {
        const { type: _type, ...outcome } = command;
        updates.setInstallOutcome(outcome);
        return;
      }
      if (command.type === 'update.reset') {
        updates.reset();
        return;
      }
      const daemon = getDaemon(command.daemon);
      if (command.type === 'daemon.set') {
        const { type: _type, daemon: _key, ...fields } = command;
        daemon.set(fields);
      } else if (command.type === 'process.add') {
        const { type: _type, daemon: _key, process: name, ...fields } = command;
        daemon.addProcess({ ...fields, name });
      } else if (command.type === 'process.remove') {
        daemon.removeProcess(command.process);
      } else if (command.type === 'process.set') {
        const { type: _type, daemon: _key, process, ...fields } = command;
        daemon.setProcess(process, fields);
      } else if (command.type === 'log.emit') {
        daemon.emitLog(command.process, command.channel, command.lines, command.repeat);
      } else if (command.type === 'log.history') {
        daemon.setLogHistory(command.process, command.channel, command.lines, command.mode);
      } else {
        daemon.rotateLog(command.process, command.channel);
      }
    };

    state = () => ({
      scenario: scenarioName,
      daemons: Array.from(daemons.values(), daemon => daemon.snapshot()),
      registry,
      update: updates.snapshot(),
    });
  })();
}

export type IFakeWorld = ReturnType<typeof createFakeWorld>;

export default define({
  createFakeWorld,
});
