import { existsSync } from 'node:fs';

/**
 * Variables that configure Electron or this app's own launch. They must not
 * reach the backend, SSH, or a ProxyCommand that SSH starts.
 */
const PRIVATE_PREFIXES = ['ELECTRON_', 'CHROME_', 'PM2_CAPTAIN_'];
const PRIVATE_NAMES = new Set(['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS_ELECTRON', 'GOOGLE_API_KEY']);

/** Where Homebrew and MacPorts install ssh helpers, ProxyCommands and the like. */
const MAC_EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];

/**
 * The environment the backend runs with: the user's environment without the
 * app's private variables. On macOS an app started from Finder gets a minimal
 * PATH, so the usual package manager directories are added when they exist;
 * nothing runs a login shell to find them.
 */
export function createBackendEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value === undefined ||
      PRIVATE_NAMES.has(name) ||
      PRIVATE_PREFIXES.some(prefix => name.startsWith(prefix))
    ) {
      continue;
    }
    environment[name] = value;
  }
  if (platform === 'darwin') {
    const entries = (environment.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':');
    for (const directory of MAC_EXTRA_PATHS) {
      if (!entries.includes(directory) && exists(directory)) {
        entries.push(directory);
      }
    }
    environment.PATH = entries.join(':');
  }
  return environment;
}
