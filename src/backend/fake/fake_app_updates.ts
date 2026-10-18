import type { IAppUpdateState } from '../../shared/desktop_bridge';
import type { IAppUpdates } from '../bl/app_updates';
import type { IContainer } from '../container';
import { define } from '../framework/dependency_injection';

/** Presents the fake world's updates through the ordinary application API. */
export function createAppUpdates({ fakeWorld }: IContainer): IAppUpdates {
  return new (class FakeAppUpdates implements IAppUpdates {
    get state() {
      return fakeWorld.updates.state;
    }

    onChange = (listener: (state: IAppUpdateState | null) => void) =>
      fakeWorld.updates.onChange(listener);

    install = async () => {
      fakeWorld.updates.install();
    };

    skip = async (version: string) => {
      fakeWorld.updates.skip(version);
    };
  })();
}

export default define({ createAppUpdates });
