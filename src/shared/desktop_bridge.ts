/**
 * The UI preferences the desktop app keeps for the renderer. A browser keeps
 * them in localStorage under the same keys; the desktop window's origin changes
 * with every launch, so its localStorage does not last.
 */
export const DESKTOP_PREFERENCE_KEYS = [
  'pm2-captain-collapsed-daemons',
  'pm2-captain-collapsed-namespaces',
  'pm2-captain-pinned-processes',
  'pm2-captain-process-sort',
  'pm2-captain-process-tab',
  'pm2-captain:process-sidebar-width',
  'pm2-captain-matrix-only-differences',
  'pm2-captain-skipped-update-version',
] as const;

export type IDesktopPreferenceKey = (typeof DESKTOP_PREFERENCE_KEYS)[number];

export type IDesktopPreferences = Partial<Record<IDesktopPreferenceKey, string>>;

/** How this installation is updated, decided by how it was installed. */
export type IDesktopInstallKind = 'appimage' | 'deb' | 'rpm' | 'mac';

export type IDesktopUpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface IDesktopUpdateState {
  status: IDesktopUpdateStatus;
  currentVersion: string;
  installKind: IDesktopInstallKind | null;
  /** The version being downloaded or ready to install. */
  version: string | null;
  /** Download progress, 0 to 100. */
  percent: number | null;
  /** Why updates are off, for example in a development build. */
  disabledReason: string | null;
  /** Which step failed. The app keeps running either way. */
  error: { phase: 'check' | 'download' | 'install'; message: string } | null;
  /** DEB and RPM installation asks for the system password. */
  requiresAuthorization: boolean;
}

/** The updater state and the user's remembered notification choice. */
export interface IAppUpdateState extends IDesktopUpdateState {
  /** Hidden until a manual check, an installation, or a different version appears. */
  skippedVersion: string | null;
}

/**
 * What the desktop preload exposes to the renderer as `window.pm2CaptainDesktop`.
 * Business operations stay on the HTTP API; this only covers what the shell owns.
 */
export interface IDesktopBridge {
  preferences: {
    load(): Promise<IDesktopPreferences>;
    set(key: IDesktopPreferenceKey, value: string): void;
  };
  updates: {
    getState(): Promise<IAppUpdateState>;
    onState(listener: (state: IAppUpdateState) => void): () => void;
    check(): Promise<void>;
    install(): Promise<void>;
    skip(version: string): Promise<void>;
  };
  /** The window's find bar, which searches the page like a browser's Ctrl+F. */
  find: {
    /** Opens the find bar, or focuses it, with its text selected. */
    open(): void;
    /** Goes to the next or previous match, opening the find bar if needed. */
    step(isForward: boolean): void;
    onOpenChange(listener: (isOpen: boolean) => void): () => void;
    /** Ctrl+Shift+F in the find bar, which hands the focus back to the page's filter boxes. */
    onBack(listener: () => void): () => void;
  };
}

/** Lists grow with the daemons, namespaces and pins. */
const MAX_LIST_LENGTH = 20_000;

const DAEMON_ID_PATTERN = /^[0-9a-f-]{36}$/i;

/** The tree's row key of a namespace: its daemon's ID, then the PM2 namespace's name. */
const NAMESPACE_ROW_KEY_PATTERN = /^namespace:[0-9a-f-]{36}:[^\p{Cc}]{1,200}$/iu;

/** The tree's row key of a process: its daemon's ID, then its PM2 ID. */
const PROCESS_ROW_KEY_PATTERN = /^process:[0-9a-f-]{36}:\d{1,10}$/i;

/** A JSON list of strings that all match the pattern. */
function isListOf(value: string, pattern: RegExp): boolean {
  if (value.length > MAX_LIST_LENGTH) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  return (
    Array.isArray(parsed) && parsed.every(item => typeof item === 'string' && pattern.test(item))
  );
}

/**
 * The values the renderer can write for each preference. The desktop app refuses
 * anything else, whether it comes from the page or from the file.
 */
const DESKTOP_PREFERENCE_VALIDATORS: Record<IDesktopPreferenceKey, (value: string) => boolean> = {
  'pm2-captain-collapsed-daemons': value => isListOf(value, DAEMON_ID_PATTERN),
  'pm2-captain-collapsed-namespaces': value => isListOf(value, NAMESPACE_ROW_KEY_PATTERN),
  'pm2-captain-pinned-processes': value => isListOf(value, PROCESS_ROW_KEY_PATTERN),
  'pm2-captain-process-sort': value => value === '' || /^[a-z]{1,20}:(asc|desc)$/.test(value),
  'pm2-captain-process-tab': value => value === 'info' || value === 'env' || value === 'logs',
  'pm2-captain:process-sidebar-width': value => /^\d{1,4}$/.test(value),
  'pm2-captain-matrix-only-differences': value => value === 'true' || value === 'false',
  'pm2-captain-skipped-update-version': value =>
    value === '' || /^[0-9A-Za-z][0-9A-Za-z.+-]{0,199}$/.test(value),
};

/** A key the page sends is untrusted until it names a known preference. */
export function isDesktopPreferenceKey(key: unknown): key is IDesktopPreferenceKey {
  return typeof key === 'string' && Object.hasOwn(DESKTOP_PREFERENCE_VALIDATORS, key);
}

/** Accepts only values the renderer could have written itself. */
export function isValidDesktopPreference(
  key: IDesktopPreferenceKey,
  value: unknown
): value is string {
  return typeof value === 'string' && DESKTOP_PREFERENCE_VALIDATORS[key](value);
}
