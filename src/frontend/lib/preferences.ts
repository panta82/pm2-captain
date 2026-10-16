import type {
  IDesktopBridge,
  IDesktopPreferenceKey,
  IDesktopPreferences,
} from '@shared/desktop_bridge';

declare global {
  interface Window {
    /** Present only in the PM2 Captain desktop app. */
    pm2CaptainDesktop?: IDesktopBridge;
  }
}

/** The bridge the desktop app's preload adds. Absent in a browser. */
export const desktopBridge = typeof window === 'undefined' ? undefined : window.pm2CaptainDesktop;

let desktopPreferences: IDesktopPreferences = {};

/**
 * Loads the desktop app's saved preferences before the UI renders. The desktop
 * window's origin changes with every launch, so localStorage would forget them.
 */
export async function loadPreferences() {
  if (desktopBridge) {
    try {
      desktopPreferences = await desktopBridge.preferences.load();
    } catch {
      desktopPreferences = {};
    }
  }
}

/** A remembered UI choice: from the desktop app, or from localStorage in a browser. */
export function readPreference(key: IDesktopPreferenceKey): string | null {
  if (desktopBridge) {
    return desktopPreferences[key] ?? null;
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreference(key: IDesktopPreferenceKey, value: string) {
  if (desktopBridge) {
    desktopPreferences = { ...desktopPreferences, [key]: value };
    desktopBridge.preferences.set(key, value);
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore private-mode and quota failures.
  }
}
