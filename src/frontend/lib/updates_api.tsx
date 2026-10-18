import { type PropsWithChildren, createContext, useContext } from 'react';

import type { IAppUpdateState, IDesktopBridge } from '@shared/desktop_bridge';

/** Update operations available to the UI, independent of its transport or runtime. */
export interface IUpdatesAPI {
  /** Delivers the current state and subsequent changes until unsubscribed. */
  subscribe(
    onState: (state: IAppUpdateState | null) => void,
    onError: (error: Error) => void
  ): () => void;
  install(): Promise<void>;
  skip(version: string): Promise<void>;
}

const UpdatesAPIContext = createContext<IUpdatesAPI | null>(null);

export function UpdatesAPIProvider({ api, children }: PropsWithChildren<{ api: IUpdatesAPI }>) {
  return <UpdatesAPIContext.Provider value={api}>{children}</UpdatesAPIContext.Provider>;
}

export function useUpdatesAPI(): IUpdatesAPI {
  const api = useContext(UpdatesAPIContext);
  if (!api) {
    throw new Error('The updates API is not available outside APIProvider.');
  }
  return api;
}

/** Adapts trusted preload IPC to the same state stream that the HTTP API provides. */
export function createDesktopUpdatesAPI(updates: IDesktopBridge['updates']): IUpdatesAPI {
  return {
    subscribe: (onState, onError) => {
      let isActive = true;
      let hasReceivedEvent = false;
      let removeListener = () => {};
      const reportError = (error: unknown) => {
        if (isActive && !hasReceivedEvent) {
          onError(error instanceof Error ? error : new Error('Unable to read update status.'));
        }
      };

      try {
        // Listen first. A slow snapshot must never overwrite a newer event.
        removeListener = updates.onState(state => {
          if (isActive) {
            hasReceivedEvent = true;
            onState(state);
          }
        });
        void updates
          .getState()
          .then(state => {
            if (isActive && !hasReceivedEvent) {
              onState(state);
            }
          })
          .catch(reportError);
      } catch (error) {
        reportError(error);
      }

      return () => {
        if (!isActive) {
          return;
        }
        isActive = false;
        removeListener();
      };
    },
    install: async () => updates.install(),
    skip: async version => updates.skip(version),
  };
}
