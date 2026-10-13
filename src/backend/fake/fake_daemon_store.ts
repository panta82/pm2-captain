import type { IDaemonConfig } from '../../shared/contracts';
import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IDaemonStore } from '../lib/daemon_store';

/**
 * Stands in for `daemonStore` in fake mode. The list starts as the scenario
 * registers it and lives in memory, so the real daemons.json is never touched.
 */
export function createDaemonStore({ fakeWorld }: IContainer): IDaemonStore {
  let saved: { generation: number; daemons: IDaemonConfig[] } | null = null;

  return new (class FakeDaemonStore {
    load = async () =>
      // What was saved belongs to the world it was saved in.
      saved?.generation === fakeWorld.generation ? saved.daemons : fakeWorld.registeredDaemons();

    save = async (daemons: IDaemonConfig[]) => {
      saved = { generation: fakeWorld.generation, daemons };
    };
  })();
}

export default define({
  createDaemonStore,
});
