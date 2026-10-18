import type { IAppUpdateState } from '../../shared/desktop_bridge';
import type { IContainer } from '../container';
import { define } from '../framework/dependency_injection';

/** Update state and actions available through the app's HTTP API. */
export interface IAppUpdates {
  /** Null when this backend has no updates to present. */
  readonly state: IAppUpdateState | null;
  onChange(listener: (state: IAppUpdateState | null) => void): () => void;
  install(): Promise<void>;
  skip(version: string): Promise<void>;
}

/** This backend cannot install an application update. */
export class AppUpdatesUnavailableError extends Error {
  readonly code = 'UPDATES_UNAVAILABLE';

  constructor() {
    super('Updates are not available through this backend.');
    this.name = 'AppUpdatesUnavailableError';
  }
}

/** Desktop installation belongs to Electron main; the ordinary backend has none. */
export function createAppUpdates(_container: IContainer): IAppUpdates {
  return new (class AppUpdates implements IAppUpdates {
    readonly state: IAppUpdateState | null = null;

    onChange = (_listener: (state: IAppUpdateState | null) => void) => () => undefined;

    install = async () => {
      throw new AppUpdatesUnavailableError();
    };

    skip = async (_version: string) => {
      throw new AppUpdatesUnavailableError();
    };
  })();
}

export default define({ createAppUpdates });
