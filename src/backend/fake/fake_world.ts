import type { IDaemonConfig } from '../../shared/contracts';
import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IAppLifecycleMethods } from '../lib/app';
import { Pm2DaemonUnavailableError } from '../lib/pm2_client';
import { IPm2DaemonIdentity } from '../lib/pm2_daemon';
import { SshConnectionError } from '../lib/ssh_connection';
import { IFakeCommand } from './fake_commands';
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

const TICK_INTERVAL_MS = 100;

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
      log.info({ daemons: daemons.size }, 'Fake world loaded');
    };

    /** The daemon list Captain starts with. Null means it was never set up. */
    registeredDaemons = (): IDaemonConfig[] | null =>
      isFirstLaunch
        ? null
        : Array.from(daemons.values())
            .filter(daemon => daemon.isRegistered)
            .map(daemon => daemon.config);

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
    });
  })();
}

export type IFakeWorld = ReturnType<typeof createFakeWorld>;

export default define({
  createFakeWorld,
});
