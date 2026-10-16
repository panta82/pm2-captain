import { randomUUID } from 'node:crypto';
import { FSWatcher, promises as fs, watch as watchDirectory } from 'node:fs';
import libPath from 'node:path';
import { lock } from 'proper-lockfile';
import { z } from 'zod';

import { IDaemonConfig, IDaemonInput } from '../../shared/contracts';
import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';

const DaemonConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    daemonId: z.string().uuid(),
    kind: z.literal('local'),
    pm2Home: z.string().startsWith('/'),
    label: z.string().min(1).optional(),
  }),
  z.object({
    daemonId: z.string().uuid(),
    kind: z.literal('ssh'),
    sshArgs: z.array(z.string()).min(1),
    pm2Home: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    lastKnownHostname: z.string().min(1).optional(),
    lastKnownUsername: z.string().min(1).optional(),
  }),
]);

const DaemonListSchema = z.array(DaemonConfigSchema);

const DaemonRegistrySchema = z.object({
  version: z.literal(1),
  // Null, like a missing file, means the daemons were never set up. An empty
  // list means the user removed them all.
  daemons: DaemonListSchema.nullable(),
});

const DAEMON_FILE_NAME = 'daemons.json';
/**
 * proper-lockfile creates this directory as the lock. It is stable across
 * replacements of daemons.json and works before that file exists.
 */
const LOCK_DIRECTORY_NAME = '.daemons.lock';
/** Editors replace files in several steps, so a burst of events becomes one reread. */
const WATCH_DEBOUNCE_MS = 150;
/** Recovers missed events and re-arms a watcher that failed or lost its directory. */
const RESCAN_INTERVAL_MS = 30_000;

/** The registry file cannot be used as it is. The message never contains file contents. */
export class DaemonRegistryError extends Error {
  readonly code = 'DAEMON_REGISTRY_INVALID';

  constructor(
    readonly path: string,
    reason: string
  ) {
    super(`${path}: ${reason}`);
    this.name = 'DaemonRegistryError';
  }
}

/** Another Captain held the registry lock for longer than a save may wait. */
export class DaemonRegistryBusyError extends Error {
  readonly code = 'DAEMON_REGISTRY_BUSY';

  constructor(readonly path: string) {
    super(`${path} is being saved by another PM2 Captain. Try again.`);
    this.name = 'DaemonRegistryBusyError';
  }
}

/**
 * Where a daemon lives. Two entries with the same key are the same daemon: the
 * resolved local path, or identical SSH arguments plus the same remote PM2 home.
 */
export function daemonLocationKey(daemon: IDaemonInput | IDaemonConfig) {
  return daemon.kind === 'local'
    ? JSON.stringify(['local', libPath.resolve(daemon.pm2Home)])
    : JSON.stringify(['ssh', daemon.sshArgs, daemon.pm2Home ?? null]);
}

function parseRegistry(path: string, content: string): IDaemonConfig[] | null {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    // V8 quotes part of the input in its message, and that can hold SSH options.
    throw new DaemonRegistryError(path, 'The file is not valid JSON.');
  }
  return validateRegistry(path, json);
}

/**
 * Checks a parsed registry: its format, and that no two daemons share an ID or
 * a location. Throws DaemonRegistryError without quoting the content. The fake
 * daemon store uses it too, so a simulated list is judged as a file would be.
 */
export function validateRegistry(path: string, json: unknown): IDaemonConfig[] | null {
  const result = DaemonRegistrySchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length ? issue.path.join('.') : 'the file';
    throw new DaemonRegistryError(
      path,
      `Unsupported content at ${where}: ${issue.message}. Daemon IDs are UUIDs; adding a daemon in Captain first shows the expected format.`
    );
  }
  const daemons = result.data.daemons;
  if (daemons) {
    const ids = new Set<string>();
    const locations = new Set<string>();
    for (const [index, daemon] of daemons.entries()) {
      if (ids.has(daemon.daemonId)) {
        throw new DaemonRegistryError(path, `daemons.${index} repeats another daemon's ID.`);
      }
      const location = daemonLocationKey(daemon);
      if (locations.has(location)) {
        throw new DaemonRegistryError(path, `daemons.${index} repeats another daemon's location.`);
      }
      ids.add(daemon.daemonId);
      locations.add(location);
    }
  }
  return daemons;
}

function serializeRegistry(daemons: IDaemonConfig[]) {
  return `${JSON.stringify({ version: 1, daemons }, null, 2)}\n`;
}

export function createDaemonStore({ settings, log }: IContainer) {
  const directory = settings.configDir;
  const path = libPath.join(directory, DAEMON_FILE_NAME);
  const lockPath = libPath.join(directory, LOCK_DIRECTORY_NAME);

  const ensureDirectory = async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
  };

  /** The file content, or null when it does not exist. */
  const readContent = async () => {
    try {
      // An atomic save replaces the link with a plain file, so a dotfile setup
      // would silently stop sharing the registry.
      if ((await fs.lstat(path)).isSymbolicLink()) {
        throw new DaemonRegistryError(
          path,
          'The file is a symbolic link. Captain saves by atomic replacement and does not follow links; put the file itself here.'
        );
      }
      return await fs.readFile(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return null;
      }
      if (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR') {
        throw new DaemonRegistryError(path, `The file cannot be read (${code}).`);
      }
      throw error;
    }
  };

  const write = async (content: string, isCompromised: () => boolean) => {
    const temporaryPath = libPath.join(directory, `.daemons-${process.pid}-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, content, { mode: 0o600 });
      await fs.chmod(temporaryPath, 0o600);
      // A lock taken over as stale belongs to someone else now; their write wins.
      if (isCompromised()) {
        throw new DaemonRegistryBusyError(path);
      }
      await fs.rename(temporaryPath, path);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  };

  return new (class DaemonStore {
    readonly path = path;

    /** Null until the daemon list is first set up. Invalid content throws DaemonRegistryError. */
    load = async (): Promise<IDaemonConfig[] | null> => {
      const content = await readContent();
      if (content === null) {
        return null;
      }
      const daemons = parseRegistry(path, content);
      await fs.chmod(path, 0o600).catch(() => undefined);
      return daemons;
    };

    /**
     * Applies one change to the newest saved list, under a lock that every
     * coordinated Captain honors. The operation receives the list as it is on
     * disk and returns the new list, or undefined to leave it alone. Resolves to
     * the list that is saved afterwards.
     */
    mutate = async (
      operation: (current: IDaemonConfig[] | null) => IDaemonConfig[] | undefined
    ): Promise<IDaemonConfig[] | null> => {
      await ensureDirectory();
      let isCompromised = false;
      let release: () => Promise<void>;
      try {
        release = await lock(path, {
          lockfilePath: lockPath,
          realpath: false,
          stale: 10_000,
          update: 2_000,
          retries: { retries: 40, factor: 1.3, minTimeout: 20, maxTimeout: 250 },
          // The default handler throws from a timer and would end the process.
          onCompromised: error => {
            isCompromised = true;
            log.warn({ error }, 'The daemon registry lock was taken over');
          },
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
          throw new DaemonRegistryBusyError(path);
        }
        throw error;
      }
      try {
        const content = await readContent();
        const current = content === null ? null : parseRegistry(path, content);
        const next = operation(current);
        if (next === undefined) {
          return current;
        }
        const validated = DaemonListSchema.parse(next);
        const nextContent = serializeRegistry(validated);
        // Parse the result too: it must be something a reload accepts.
        parseRegistry(path, nextContent);
        if (nextContent !== content) {
          await write(nextContent, () => isCompromised);
        }
        return validated;
      } finally {
        await release().catch(error => {
          log.debug({ error }, 'Unable to release the daemon registry lock');
        });
      }
    };

    /**
     * Calls `onHint` after the registry may have changed: a debounced directory
     * event, or the periodic rescan. The listener rereads the file itself.
     * Returns the function that stops watching.
     */
    watch = async (onHint: () => void) => {
      let watcher: FSWatcher | null = null;
      let debounceTimer: NodeJS.Timeout | null = null;
      let isStopped = false;
      let isDegraded = false;

      const schedule = () => {
        if (isStopped || debounceTimer) {
          return;
        }
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          if (!isStopped) {
            onHint();
          }
        }, WATCH_DEBOUNCE_MS);
      };

      const closeWatcher = () => {
        watcher?.close();
        watcher = null;
      };

      const arm = () => {
        if (isStopped || watcher) {
          return;
        }
        try {
          // The directory, not the file: editors and atomic saves replace the file.
          watcher = watchDirectory(directory, { persistent: false }, schedule);
          watcher.on('error', error => {
            log.warn({ error }, 'Watching the daemon registry failed; rescanning periodically');
            isDegraded = true;
            closeWatcher();
          });
          if (isDegraded) {
            log.info('Watching the daemon registry again');
            isDegraded = false;
          }
        } catch (error) {
          if (!isDegraded) {
            log.warn({ error }, 'Unable to watch the daemon registry; rescanning periodically');
            isDegraded = true;
          }
        }
      };

      const rescanTimer = setInterval(() => {
        // A recreated directory can reuse its old inode while the old watcher
        // stays deaf. Reopen unconditionally, without an asynchronous stat race.
        closeWatcher();
        arm();
        schedule();
      }, RESCAN_INTERVAL_MS);
      rescanTimer.unref();

      await ensureDirectory().catch(error =>
        log.warn({ error }, 'Unable to create the Captain config directory')
      );
      arm();

      return () => {
        isStopped = true;
        clearInterval(rescanTimer);
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        closeWatcher();
      };
    };
  })();
}

export type IDaemonStore = ReturnType<typeof createDaemonStore>;

export default define({
  createDaemonStore,
});
