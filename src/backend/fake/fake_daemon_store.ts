import type { IDaemonConfig } from '../../shared/contracts';
import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { DaemonRegistryError, IDaemonStore, validateRegistry } from '../lib/daemon_store';
import type { IFakeRegistryFailure } from './fake_world';

const FAKE_REGISTRY_PATH = 'fake:daemons.json';

/** The real store's messages for the same failures. */
const FAILURE_MESSAGES: Record<Exclude<IFakeRegistryFailure, 'missing'>, string> = {
  invalid: 'The file is not valid JSON.',
  unreadable: 'The file cannot be read (EACCES).',
};

/**
 * Stands in for `daemonStore` in fake mode. The list lives in the fake world,
 * so the real daemons.json is never touched, while Captain's reload, reconcile
 * and conflict handling run as they do on a real file. Commands can edit or
 * break the list, as an editor or another Captain would.
 */
export function createDaemonStore({ fakeWorld }: IContainer): IDaemonStore {
  const read = () => {
    const { daemons, failure } = fakeWorld.registry;
    if (failure === 'missing') {
      return null;
    }
    if (failure) {
      throw new DaemonRegistryError(FAKE_REGISTRY_PATH, FAILURE_MESSAGES[failure]);
    }
    // An edit from outside can leave two daemons at one location, as a hand
    // edit can; Captain then keeps its last working list, as for a file.
    return validateRegistry(FAKE_REGISTRY_PATH, { version: 1, daemons });
  };

  return new (class FakeDaemonStore {
    readonly path = FAKE_REGISTRY_PATH;

    load = async () => read();

    mutate = async (
      operation: (current: IDaemonConfig[] | null) => IDaemonConfig[] | undefined
    ) => {
      const daemons = read();
      const next = operation(daemons);
      if (next === undefined) {
        return daemons;
      }
      // Captain never saves a list that it would refuse to read.
      const validated = validateRegistry(FAKE_REGISTRY_PATH, { version: 1, daemons: next })!;
      fakeWorld.saveRegistry(validated);
      return validated;
    };

    // A change in the world reaches Captain the way a file change would.
    watch = async (onHint: () => void) => fakeWorld.onRegistryChange(onHint);
  })();
}

export default define({
  createDaemonStore,
});
