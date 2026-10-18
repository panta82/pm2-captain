import type { IAppUpdateState } from '../../shared/desktop_bridge';
import type { IFileLog } from './desktop_log';
import type { IPreferenceStore } from './preferences';
import type { IUpdateController } from './updates';

const SKIPPED_VERSION_KEY = 'pm2-captain-skipped-update-version';

/** Adds persistent notification choices to either update controller. */
export function createUpdateNotifications({
  source,
  preferences,
  log,
}: {
  source: IUpdateController;
  preferences: IPreferenceStore;
  log: IFileLog;
}) {
  let skippedVersion = preferences.ui()[SKIPPED_VERSION_KEY] || null;
  let unsubscribe: (() => void) | null = null;
  const listeners = new Set<(state: IAppUpdateState) => void>();
  const snapshot = (): IAppUpdateState => ({ ...source.state, skippedVersion });
  const emitState = () => {
    const state = snapshot();
    for (const listener of listeners) {
      listener(state);
    }
  };
  const clearSkippedVersion = () => {
    if (skippedVersion !== null) {
      skippedVersion = null;
      preferences.setUi(SKIPPED_VERSION_KEY, '');
      emitState();
    }
  };

  return {
    get state() {
      return snapshot();
    },
    onState: (listener: (state: IAppUpdateState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      unsubscribe ??= source.onState(emitState);
      source.start();
    },
    stop: () => {
      unsubscribe?.();
      unsubscribe = null;
      source.stop();
    },
    check: async () => {
      // Background checks run inside the source and never clear the user's choice.
      clearSkippedVersion();
      await source.check();
    },
    install: async () => {
      clearSkippedVersion();
      await source.install();
    },
    skip: async (version: string) => {
      // A queued click must not hide a newer download or an active installation.
      if (source.state.status !== 'downloaded' || source.state.version !== version) {
        return;
      }
      if (skippedVersion !== version) {
        if (!preferences.setUi(SKIPPED_VERSION_KEY, version)) {
          throw new Error('The update version could not be remembered.');
        }
        skippedVersion = version;
        log.info('Update notification skipped', { version });
        emitState();
      }
    },
  };
}
