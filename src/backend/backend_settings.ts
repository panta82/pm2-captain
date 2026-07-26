import libOs from 'node:os';
import libPath from 'node:path';

import { z } from 'zod';

const BackendSettingsSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('production'),
  host: z.literal('127.0.0.1').default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(3212),
  pm2Home: z.string().min(1),
  debug: z.boolean().default(false),
  serverDevMode: z.boolean().default(false),
  skipBrowserOpen: z.boolean().default(false),
});

export type IBackendSettings = z.infer<typeof BackendSettingsSchema> & {
  baseURL: string;
};

export function loadBackendSettings(): IBackendSettings {
  const args: { port?: number; pm2Home?: string; open: boolean } = { open: true };
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === '--no-open') {
      args.open = false;
    } else if (argument === '--port' || argument === '-p') {
      args.port = Number(process.argv[++index]);
    } else if (argument === '--pm2-home') {
      args.pm2Home = process.argv[++index];
    } else if (argument === '--help' || argument === '-h') {
      console.log(`Usage: pm2-captain [options]

Options:
  -p, --port <number>   HTTP port (default: 3212)
  --pm2-home <path>     PM2 home directory (default: PM2_HOME or ~/.pm2)
  --no-open             Do not open a browser
  -h, --help            Show this help`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  const ownSettings = BackendSettingsSchema.parse({
    nodeEnv: process.env.NODE_ENV || 'production',
    port: args.port ?? (process.env.PM2_CAPTAIN_PORT ? Number(process.env.PM2_CAPTAIN_PORT) : 3212),
    pm2Home:
      args.pm2Home ||
      process.env.PM2_HOME ||
      libPath.join(libOs.homedir(), '.pm2'),
    debug: process.env.DEBUG === 'true',
    serverDevMode:
      process.env.SERVER_DEV_MODE === 'true' || process.env.NODE_ENV === 'development',
    skipBrowserOpen: !args.open || process.env.PM2_CAPTAIN_NO_OPEN === 'true',
  });

  process.env.PM2_HOME = ownSettings.pm2Home;

  return {
    ...ownSettings,
    baseURL: `http://${ownSettings.host}:${ownSettings.port}`,
  };
}

export const ROOT_DIR = libPath.resolve(__dirname, '..', '..');
