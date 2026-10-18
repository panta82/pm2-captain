import type { IAppUpdateState, IDesktopInstallKind } from '../../shared/desktop_bridge';
import { InvalidFakeCommandError } from './fake_commands';

/** What a simulated installation does when the user starts it. */
export interface IFakeInstallOutcome {
  /** "fail" ends in an install error; "stay" keeps it installing until the next command. */
  outcome: 'fail' | 'stay';
  message: string;
}

const DEFAULT_INSTALL_OUTCOME: IFakeInstallOutcome = {
  outcome: 'fail',
  message: 'The simulated installation failed.',
};

/** The fields `update.set` accepts. The error is flat, like every fake command field. */
export interface IFakeUpdateFields {
  status: IAppUpdateState['status'];
  version?: string | null;
  percent?: number | null;
  installKind?: IDesktopInstallKind;
  errorPhase?: 'check' | 'download' | 'install' | null;
  errorMessage?: string | null;
}

/**
 * A simulated desktop update, for the update notification and install action in fake
 * mode. Nothing here downloads, installs or restarts anything.
 */
export function createFakeUpdates(currentVersion: string) {
  const initialState = (): IAppUpdateState => ({
    status: 'idle',
    currentVersion,
    installKind: 'appimage',
    version: null,
    percent: null,
    disabledReason: null,
    error: null,
    requiresAuthorization: false,
    skippedVersion: null,
  });
  let state = initialState();
  let installOutcome = DEFAULT_INSTALL_OUTCOME;
  let checkCount = 0;
  const listeners = new Set<(state: IAppUpdateState) => void>();

  const setState = (next: IAppUpdateState) => {
    state = next;
    for (const listener of listeners) {
      listener(state);
    }
  };

  return {
    get state() {
      return state;
    },

    snapshot: () => ({ ...state, installOutcome, checkCount }),

    onChange: (listener: (state: IAppUpdateState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    set: (fields: IFakeUpdateFields) => {
      const version = fields.version ?? null;
      if (['downloading', 'downloaded', 'installing'].includes(fields.status) && !version) {
        throw new InvalidFakeCommandError(`An update that is ${fields.status} needs a version.`);
      }
      if (Boolean(fields.errorPhase) !== Boolean(fields.errorMessage)) {
        throw new InvalidFakeCommandError('Give both errorPhase and errorMessage, or neither.');
      }
      const installKind = fields.installKind ?? state.installKind ?? 'appimage';
      setState({
        ...initialState(),
        status: fields.status,
        installKind,
        version,
        percent:
          fields.percent ??
          (fields.status === 'downloaded' ? 100 : fields.status === 'downloading' ? 0 : null),
        disabledReason:
          fields.status === 'disabled' ? 'Updates are turned off in this simulation.' : null,
        error:
          fields.errorPhase && fields.errorMessage
            ? { phase: fields.errorPhase, message: fields.errorMessage }
            : null,
        requiresAuthorization: installKind === 'deb' || installKind === 'rpm',
        skippedVersion: state.skippedVersion,
      });
    },

    setInstallOutcome: (
      outcome: Partial<IFakeInstallOutcome> & Pick<IFakeInstallOutcome, 'outcome'>
    ) => {
      installOutcome = { ...DEFAULT_INSTALL_OUTCOME, ...outcome };
    },

    /** A manual check restores a skipped notification without downloading anything. */
    check: () => {
      checkCount++;
      if (state.skippedVersion !== null) {
        setState({ ...state, skippedVersion: null });
      }
    },

    skip: (version: string) => {
      if (state.status === 'downloaded' && state.version === version) {
        setState({ ...state, skippedVersion: version });
      }
    },

    /** The user asked to install. Only a downloaded update can be installed. */
    install: () => {
      if (state.status !== 'downloaded') {
        return;
      }
      setState({ ...state, status: 'installing', error: null, skippedVersion: null });
      if (installOutcome.outcome === 'fail') {
        setState({
          ...state,
          status: 'downloaded',
          error: { phase: 'install', message: installOutcome.message },
        });
      }
    },

    reset: () => {
      installOutcome = DEFAULT_INSTALL_OUTCOME;
      checkCount = 0;
      setState(initialState());
    },
  };
}

export type IFakeUpdates = ReturnType<typeof createFakeUpdates>;
