import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import libPath from 'node:path';
import { z } from 'zod';

import { IDaemonConfig } from '../../shared/contracts';
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

export function createDaemonStore({ settings }: IContainer) {
  const directory = settings.configDir;
  const path = libPath.join(directory, DAEMON_FILE_NAME);
  let writeQueue = Promise.resolve();

  const write = async (daemons: IDaemonConfig[]) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporaryPath = libPath.join(directory, `.daemons-${process.pid}-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify({ version: 1, daemons }, null, 2)}\n`, {
        mode: 0o600,
      });
      await fs.chmod(temporaryPath, 0o600);
      await fs.rename(temporaryPath, path);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  };

  return new (class DaemonStore {
    /** Null until the daemon list is first set up. */
    load = async (): Promise<IDaemonConfig[] | null> => {
      let content: string;
      try {
        content = await fs.readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        throw error;
      }

      const registry = DaemonRegistrySchema.parse(JSON.parse(content));
      await fs.chmod(path, 0o600);
      return registry.daemons;
    };

    save = async (daemons: IDaemonConfig[]) => {
      const validatedDaemons = DaemonListSchema.parse(daemons);
      const operation = writeQueue.then(() => write(validatedDaemons));
      writeQueue = operation.catch(() => undefined);
      await operation;
    };
  })();
}

export type IDaemonStore = ReturnType<typeof createDaemonStore>;

export default define({
  createDaemonStore,
});
