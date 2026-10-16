import type { IDesktopBackendOptions } from '../../backend/backend_settings';
import type { IDesktopUpdateState } from '../../shared/desktop_bridge';

const UPDATE_STATUSES = new Set([
  'disabled',
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'installing',
  'error',
]);

/** Messages from Electron main to the backend utility process. */
export type IBackendRequest =
  | { type: 'start'; runId: string; options: IDesktopBackendOptions }
  | { type: 'stop'; runId: string }
  /** Fake mode: the user acted on the simulated update. */
  | { type: 'fake-update-action'; action: 'check' | 'install' };

/** Why the backend could not start. The message is safe to show. */
export interface IBackendStartupError {
  code: 'REGISTRY_INVALID' | 'STARTUP_FAILED';
  message: string;
  /** The file to fix, for a registry error. */
  path: string | null;
}

/** Messages from the backend to Electron main. Only main ever sees the token. */
export type IBackendMessage =
  | { type: 'ready'; runId: string; baseURL: string; launchToken: string }
  | { type: 'failed'; runId: string; error: IBackendStartupError }
  | { type: 'stopped'; runId: string }
  /** The SSH processes the backend started, which main ends if the backend dies. */
  | { type: 'owned-processes'; pids: number[] }
  /** Fake mode: the simulated update changed. */
  | { type: 'fake-update'; state: IDesktopUpdateState };

export function isBackendMessage(value: unknown): value is IBackendMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const message = value as Record<string, unknown>;
  if (message.type === 'fake-update') {
    const state = message.state as Record<string, unknown> | null;
    return (
      typeof state === 'object' &&
      state !== null &&
      UPDATE_STATUSES.has(state.status as string) &&
      typeof state.currentVersion === 'string' &&
      typeof state.requiresAuthorization === 'boolean'
    );
  }
  if (message.type === 'owned-processes') {
    return (
      Array.isArray(message.pids) &&
      message.pids.every(pid => Number.isInteger(pid) && (pid as number) > 1)
    );
  }
  if (typeof message.runId !== 'string') {
    return false;
  }
  if (message.type === 'ready') {
    return (
      typeof message.baseURL === 'string' &&
      /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(message.baseURL) &&
      typeof message.launchToken === 'string' &&
      message.launchToken.length >= 32
    );
  }
  if (message.type === 'failed') {
    const error = message.error as Record<string, unknown> | null;
    return typeof error === 'object' && error !== null && typeof error.message === 'string';
  }
  return message.type === 'stopped';
}
