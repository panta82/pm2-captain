import type { IDesktopUpdateState } from '../../shared/desktop_bridge';
import type { IFileLog } from './desktop_log';
import type { IUpdateController } from './updates';

/**
 * Fake mode's updates: the state comes from the backend's simulated update,
 * which fake commands control, and the user's actions go back to it. The
 * window, menu and IPC treat it like the real controller; nothing is
 * downloaded, installed or restarted.
 */
export function createSimulatedUpdateController({
  currentVersion,
  log,
  sendAction,
}: {
  currentVersion: string;
  log: IFileLog;
  sendAction: (action: 'check' | 'install') => void;
}) {
  let state: IDesktopUpdateState = {
    status: 'idle',
    currentVersion,
    installKind: 'appimage',
    version: null,
    percent: null,
    disabledReason: null,
    error: null,
    requiresAuthorization: false,
  };
  const listeners = new Set<(state: IDesktopUpdateState) => void>();

  const controller: IUpdateController & { receive(state: IDesktopUpdateState): void } = {
    get state() {
      return state;
    },
    onState: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => log.info('Updates are simulated in fake mode'),
    stop: () => undefined,
    check: async () => sendAction('check'),
    install: async () => sendAction('install'),
    /** The backend reported the simulated update. */
    receive: next => {
      state = next;
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
  return controller;
}
