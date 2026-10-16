import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import libPath from 'node:path';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export type IDesktopLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * A small line-oriented file log for the desktop shell and its backend output.
 * One previous file is kept. Callers never pass tokens, cookies or environment
 * values.
 */
export function createFileLog(directory: string, name: string, isDebug = false) {
  const path = libPath.join(directory, `${name}.log`);
  let isReady = false;

  const ensureDirectory = () => {
    if (!isReady) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      isReady = true;
    }
  };

  const rotateIfLarge = () => {
    try {
      if (statSync(path).size > MAX_LOG_BYTES) {
        renameSync(path, `${path}.1`);
      }
    } catch {
      // No file yet.
    }
  };

  const write = (line: string) => {
    try {
      ensureDirectory();
      rotateIfLarge();
      appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`, { mode: 0o600 });
    } catch {
      // Logging must never take the app down.
    }
  };

  const log = (level: IDesktopLogLevel, message: string, details?: Record<string, unknown>) => {
    if (level === 'debug' && !isDebug) {
      return;
    }
    const detailText = details ? ` ${JSON.stringify(details, errorReplacer)}` : '';
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${detailText}`;
    write(line);
    if (isDebug || level === 'error') {
      process.stderr.write(`${line}\n`);
    }
  };

  return {
    path,
    /** Appends raw output, such as the backend's own log lines. */
    raw: write,
    debug: (message: string, details?: Record<string, unknown>) => log('debug', message, details),
    info: (message: string, details?: Record<string, unknown>) => log('info', message, details),
    warn: (message: string, details?: Record<string, unknown>) => log('warn', message, details),
    error: (message: string, details?: Record<string, unknown>) => log('error', message, details),
  };
}

export type IFileLog = ReturnType<typeof createFileLog>;

function errorReplacer(_key: string, value: unknown) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: (value as { code?: unknown }).code };
  }
  return value;
}
