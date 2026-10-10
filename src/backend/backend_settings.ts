import { readFileSync } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { z } from 'zod';

import type { IDaemonInput } from '../shared/contracts';

export const ROOT_DIR = libPath.resolve(__dirname, '..', '..');
export const PACKAGE_VERSION = z
  .object({ version: z.string().min(1) })
  .parse(JSON.parse(readFileSync(libPath.join(ROOT_DIR, 'package.json'), 'utf8'))).version;

const BackendSettingsSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('production'),
  host: z.literal('127.0.0.1').default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(3212),
  /** Captain's own files: the daemon registry and the launch token. */
  configDir: z.string().min(1),
  /**
   * The app container holds the PM2 home requested with --pm2-home. Each daemon
   * container holds that daemon's PM2 home; for SSH daemons null means the remote
   * default.
   */
  pm2Home: z.string().min(1).nullable().default(null),
  /** PM2_HOME from the environment, used only to detect local PM2 homes. */
  environmentPm2Home: z.string().min(1).nullable().default(null),
  debug: z.boolean().default(false),
  serverDevMode: z.boolean().default(false),
  /**
   * "auto" opens a browser tab unless one from the previous run is expected to
   * reconnect.
   */
  browserOpen: z.enum(['auto', 'always', 'never']).default('auto'),
  noAuth: z.boolean().default(false),
  sshArgs: z.array(z.string()).nullable().default(null),
  runtimeDaemonId: z.string().nullable().default(null),
});

export type IBackendSettings = z.infer<typeof BackendSettingsSchema> & {
  baseURL: string;
};

function defaultConfigDir() {
  return libPath.join(
    process.env.XDG_CONFIG_HOME || libPath.join(libOs.homedir(), '.config'),
    'pm2-captain'
  );
}

/** Expands a leading `~` and makes the path absolute. */
export function resolveLocalPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    return libPath.join(libOs.homedir(), trimmed.slice(1));
  }
  return libPath.resolve(trimmed);
}

/** The daemon named on the command line, if any. */
export function requestedDaemonInput(settings: IBackendSettings): IDaemonInput | null {
  if (settings.sshArgs) {
    return {
      kind: 'ssh',
      sshArgs: settings.sshArgs,
      ...(settings.pm2Home ? { pm2Home: settings.pm2Home } : {}),
    };
  }
  return settings.pm2Home ? { kind: 'local', pm2Home: settings.pm2Home } : null;
}

export function loadBackendSettings(): IBackendSettings {
  const args: {
    port?: number;
    pm2Home?: string;
    open: boolean | null;
    noAuth: boolean;
    sshArgs: string[] | null;
  } = {
    open: null,
    noAuth: false,
    sshArgs: null,
  };
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === 'ssh') {
      args.sshArgs = process.argv.slice(index + 1);
      if (!args.sshArgs.length) {
        throw new Error('The ssh command requires a destination.');
      }
      break;
    } else if (argument === '--open') {
      args.open = true;
    } else if (argument === '--no-open') {
      args.open = false;
    } else if (argument === '--no-auth') {
      args.noAuth = true;
    } else if (argument === '--port' || argument === '-p') {
      args.port = Number(process.argv[++index]);
    } else if (argument === '--pm2-home') {
      args.pm2Home = process.argv[++index];
    } else if (argument === '--help' || argument === '-h') {
      console.log(`Usage: pm2-captain [options]
       pm2-captain [options] ssh <ssh arguments>

Options:
  -p, --port <number>   HTTP port (default: 3212)
  --pm2-home <path>     Add the PM2 home at this path. With "ssh", the path is
                        on the remote server.
  --open                Always open a browser tab. By default a restart reuses
                        the tab that is already open.
  --no-open             Do not open a browser
  --no-auth             Disable Captain authentication (use behind an authenticated proxy)
  -h, --help            Show this help

Remote server:
  pm2-captain ssh tk-dev
  pm2-captain --port 3213 ssh -p 2222 user@example.com
  pm2-captain --pm2-home /srv/pm2 ssh deploy@example.com

Arguments after "ssh" are passed to your system SSH client. Captain uses its
configuration, keys, agent, and jump hosts, and does not install anything on
the remote server.

Daemons are saved in ${defaultConfigDir()}/daemons.json. On the
first launch, Captain fills that list with the PM2 daemons it finds on this
computer.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  const ownSettings = BackendSettingsSchema.parse({
    nodeEnv: process.env.NODE_ENV || 'production',
    port: args.port ?? (process.env.PM2_CAPTAIN_PORT ? Number(process.env.PM2_CAPTAIN_PORT) : 3212),
    configDir: defaultConfigDir(),
    // A remote path is resolved on the server. A local one is resolved here,
    // because a running Captain that receives the handoff has another cwd.
    pm2Home: args.pm2Home && !args.sshArgs ? resolveLocalPath(args.pm2Home) : args.pm2Home || null,
    environmentPm2Home: process.env.PM2_HOME || null,
    debug: process.env.DEBUG === 'true',
    serverDevMode: process.env.SERVER_DEV_MODE === 'true' || process.env.NODE_ENV === 'development',
    browserOpen:
      args.open === false || (args.open === null && process.env.PM2_CAPTAIN_NO_OPEN === 'true')
        ? 'never'
        : args.open
          ? 'always'
          : 'auto',
    noAuth: args.noAuth || process.env.PM2_CAPTAIN_NO_AUTH === 'true',
    sshArgs: args.sshArgs,
    runtimeDaemonId: null,
  });

  return {
    ...ownSettings,
    baseURL: `http://${ownSettings.host}:${ownSettings.port}`,
  };
}
