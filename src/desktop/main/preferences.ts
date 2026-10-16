import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import libPath from 'node:path';

import {
  DESKTOP_PREFERENCE_KEYS,
  IDesktopPreferenceKey,
  IDesktopPreferences,
  isValidDesktopPreference,
} from '../../shared/desktop_bridge';

const FILE_NAME = 'preferences.json';
const SAVE_DELAY_MS = 500;

export interface IWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

interface IPreferenceFile {
  version: 1;
  ui: IDesktopPreferences;
  window: IWindowState | null;
}

function parseWindowState(value: unknown): IWindowState | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const state = value as Record<string, unknown>;
  const isSize = (size: unknown) =>
    Number.isInteger(size) && (size as number) >= 200 && (size as number) <= 20_000;
  const isPosition = (position: unknown) =>
    position === undefined ||
    (Number.isInteger(position) && Math.abs(position as number) <= 50_000);
  if (
    !isSize(state.width) ||
    !isSize(state.height) ||
    !isPosition(state.x) ||
    !isPosition(state.y)
  ) {
    return null;
  }
  return {
    ...(state.x !== undefined ? { x: state.x as number } : {}),
    ...(state.y !== undefined ? { y: state.y as number } : {}),
    width: state.width as number,
    height: state.height as number,
    isMaximized: state.isMaximized === true,
  };
}

/**
 * The desktop app's own settings: the renderer's UI preferences and the window
 * bounds. Readable JSON in the Electron profile, private to the user. Never
 * tokens, process data, environment values or logs.
 */
export function createPreferenceStore(directory: string) {
  const path = libPath.join(directory, FILE_NAME);
  let state: IPreferenceFile = { version: 1, ui: {}, window: null };
  let saveTimer: NodeJS.Timeout | null = null;

  try {
    const content = JSON.parse(readFileSync(path, 'utf8')) as Partial<IPreferenceFile>;
    const ui: IDesktopPreferences = {};
    for (const key of DESKTOP_PREFERENCE_KEYS) {
      const value = (content.ui as Record<string, unknown> | undefined)?.[key];
      if (isValidDesktopPreference(key, value)) {
        ui[key] = value as string;
      }
    }
    state = { version: 1, ui, window: parseWindowState(content.window) };
  } catch {
    // Missing or unreadable preferences start from the defaults.
  }

  const save = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
  };

  const scheduleSave = () => {
    if (!saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
          save();
        } catch {
          // The next change or the flush on quit tries again.
        }
      }, SAVE_DELAY_MS);
    }
  };

  return {
    path,
    ui: () => ({ ...state.ui }),
    /** Returns false for a key or value the renderer could not legitimately send. */
    setUi: (key: string, value: unknown): boolean => {
      if (!isValidDesktopPreference(key, value)) {
        return false;
      }
      if (state.ui[key as IDesktopPreferenceKey] !== value) {
        state.ui = { ...state.ui, [key]: value as string };
        scheduleSave();
      }
      return true;
    },
    window: () => state.window,
    setWindow: (window: IWindowState) => {
      const parsed = parseWindowState(window);
      if (parsed) {
        state.window = parsed;
        scheduleSave();
      }
    },
    /** Writes pending changes now, before a quit or an update. */
    flush: () => {
      if (saveTimer) {
        save();
      }
    },
  };
}

export type IPreferenceStore = ReturnType<typeof createPreferenceStore>;
