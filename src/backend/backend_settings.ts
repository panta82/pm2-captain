import { readFileSync } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { z } from 'zod';

import type { IDaemonInput } from '../shared/contracts';
import type { ICliArgs } from './cli_args';

export const ROOT_DIR = libPath.resolve(__dirname, '..', '..');
export const PACKAGE_VERSION = z
  .object({ version: z.string().min(1) })
  .parse(JSON.parse(readFileSync(libPath.join(ROOT_DIR, 'package.json'), 'utf8'))).version;

export const DEFAULT_PORT = 3212;
/** Fake mode has its own port, so it never lands on a Captain that shows real daemons. */
export const DEFAULT_FAKE_PORT = 3213;

export const BackendSettingsSchema = z
  .object({
    nodeEnv: z.enum(['development', 'test', 'production']).default('production'),
    /**
     * "cli" is the npm command. "desktop" is a backend owned by the desktop app:
     * it has an in-memory launch token, no browser launch policy, and may listen
     * on an OS-assigned port.
     */
    runtime: z.enum(['cli', 'desktop']).default('cli'),
    host: z.literal('127.0.0.1').default('127.0.0.1'),
    /** 0 lets the OS pick a port; only a desktop backend asks for that. */
    port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
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
    runtimeConnectionId: z.string().nullable().default(null),
    /**
     * Set in fake mode, where simulated PM2 daemons replace the real ones. The
     * scenario is a built-in name or the path to a JSON file.
     */
    fake: z
      .object({
        scenario: z.string().min(1),
        /**
         * Desktop only: where the backend writes its address and a fake-only
         * control token, so `pm2-captain fake --control <file>` can reach it.
         */
        controlFile: z.string().min(1).nullable().default(null),
      })
      .nullable()
      .default(null),
    /** The arguments after the "fake" subcommand, sent to a Captain running in fake mode. */
    fakeCommand: z.array(z.string()).min(1).nullable().default(null),
  })
  .refine(settings => settings.port !== 0 || settings.runtime === 'desktop', {
    message: 'The port must be between 1 and 65535.',
    path: ['port'],
  });

export type IBackendSettings = z.infer<typeof BackendSettingsSchema> & {
  /**
   * The configured URL. A desktop backend asks for port 0, so its real origin
   * is only known once it listens; see webServer.baseURL.
   */
  baseURL: string;
};

/** What the desktop app chooses for the backend it owns. */
export interface IDesktopBackendOptions {
  configDir: string;
  environmentPm2Home: string | null;
  fakeScenario: string | null;
  /** With fakeScenario: where to write the fake control file. */
  fakeControlFile: string | null;
  debug: boolean;
  /** Development only: serve the frontend from source through Vite. */
  serverDevMode: boolean;
}

/**
 * Settings for a backend started by the desktop app. Nothing comes from the
 * command line: Electron's arguments are not Captain options.
 */
export function createDesktopBackendSettings(options: IDesktopBackendOptions): IBackendSettings {
  const ownSettings = BackendSettingsSchema.parse({
    nodeEnv: options.serverDevMode ? 'development' : 'production',
    runtime: 'desktop',
    port: 0,
    configDir: options.configDir,
    environmentPm2Home: options.environmentPm2Home,
    debug: options.debug,
    serverDevMode: options.serverDevMode,
    browserOpen: 'never',
    fake: options.fakeScenario
      ? { scenario: options.fakeScenario, controlFile: options.fakeControlFile }
      : null,
  });
  return { ...ownSettings, baseURL: `http://${ownSettings.host}:${ownSettings.port}` };
}

export function defaultConfigDir() {
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

/** Settings for the npm command, from its parsed command line and the environment. */
export function loadBackendSettings(args: ICliArgs): IBackendSettings {
  const fakeScenario = args.fakeScenario ?? (process.env.PM2_CAPTAIN_FAKE || null);
  const sshArgs = args.ssh?.sshArgs ?? null;
  const fakeCommand = args.fake?.command ?? null;

  const ownSettings = BackendSettingsSchema.parse({
    nodeEnv: process.env.NODE_ENV || 'production',
    port:
      args.port ??
      (process.env.PM2_CAPTAIN_PORT
        ? Number(process.env.PM2_CAPTAIN_PORT)
        : fakeScenario || fakeCommand
          ? DEFAULT_FAKE_PORT
          : DEFAULT_PORT),
    configDir: defaultConfigDir(),
    // A remote path is resolved on the server. A local one is resolved here,
    // because a running Captain that receives the handoff has another cwd.
    pm2Home: args.pm2Home && !sshArgs ? resolveLocalPath(args.pm2Home) : args.pm2Home || null,
    environmentPm2Home: process.env.PM2_HOME || null,
    debug: process.env.DEBUG === 'true',
    serverDevMode: process.env.SERVER_DEV_MODE === 'true' || process.env.NODE_ENV === 'development',
    browserOpen:
      args.open === false || (args.open === undefined && process.env.PM2_CAPTAIN_NO_OPEN === 'true')
        ? 'never'
        : args.open
          ? 'always'
          : 'auto',
    noAuth: args.noAuth === true || process.env.PM2_CAPTAIN_NO_AUTH === 'true',
    sshArgs,
    runtimeDaemonId: null,
    runtimeConnectionId: null,
    fake: fakeScenario ? { scenario: fakeScenario } : null,
    fakeCommand,
  });

  return {
    ...ownSettings,
    baseURL: `http://${ownSettings.host}:${ownSettings.port}`,
  };
}
