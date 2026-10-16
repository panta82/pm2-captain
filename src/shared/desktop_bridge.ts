/**
 * The UI preferences the desktop app keeps for the renderer. A browser keeps
 * them in localStorage under the same keys; the desktop window's origin changes
 * with every launch, so its localStorage does not last.
 */
export const DESKTOP_PREFERENCE_KEYS = [
  'pm2-captain-selected-daemon',
  'pm2-captain-process-tab',
  'pm2-captain:process-sidebar-width',
  'pm2-captain-matrix-only-differences',
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
    getState(): Promise<IDesktopUpdateState>;
    onState(listener: (state: IDesktopUpdateState) => void): () => void;
    check(): Promise<void>;
    install(): Promise<void>;
  };
}

/** Accepts only values the renderer could have written itself. */
export function isValidDesktopPreference(
  key: string,
  value: unknown
): key is IDesktopPreferenceKey {
  if (typeof value !== 'string' || value.length > 200) {
    return false;
  }
  switch (key) {
    case 'pm2-captain-selected-daemon':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    case 'pm2-captain-process-tab':
      return value === 'info' || value === 'env' || value === 'logs';
    case 'pm2-captain:process-sidebar-width':
      return /^\d{1,4}$/.test(value);
    case 'pm2-captain-matrix-only-differences':
      return value === 'true' || value === 'false';
    default:
      return false;
  }
}
