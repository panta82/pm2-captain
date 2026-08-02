import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { accessSync, promises as fs, constants as fsConstants } from 'node:fs';
import libNet from 'node:net';
import libPath from 'node:path';

import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IAppLifecycleMethods, IAppWaitForMethod } from '../lib/app';

const TOKEN_FILE_NAME = 'pm2-captain-token';
export const PORT_CONFLICT_EXIT_CODE = 78;

export class PortConflictError extends Error {}

type IBrowserOpenCommand = [command: string, args: string[]];

function findExecutable(
  name: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
) {
  const pathSeparator = platform === 'win32' ? ';' : ':';
  for (const directory of environment.PATH?.split(pathSeparator) || []) {
    if (!directory) {
      continue;
    }
    const candidate = libPath.join(directory, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching the remaining PATH entries.
    }
  }
  return null;
}

export function resolveBrowserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  resolveExecutable: (
    name: string,
    platform?: NodeJS.Platform,
    environment?: NodeJS.ProcessEnv
  ) => string | null = findExecutable
): IBrowserOpenCommand | null {
  if (platform === 'darwin') {
    const command = resolveExecutable('open', platform, environment);
    return command ? [command, [url]] : null;
  }
  if (platform === 'win32') {
    const command =
      environment.ComSpec ||
      resolveExecutable('cmd.exe', platform, environment) ||
      resolveExecutable('cmd', platform, environment);
    return command ? [command, ['/c', 'start', '', url]] : null;
  }
  if (!environment.DISPLAY && !environment.WAYLAND_DISPLAY) {
    return null;
  }
  const command = resolveExecutable('xdg-open', platform, environment);
  return command ? [command, [url]] : null;
}

export function createCaptainLauncher({ settings, log }: IContainer) {
  let token = '';

  const ensureToken = async () => {
    if (token) {
      return token;
    }
    const tokenPath = libPath.join(settings.pm2Home, TOKEN_FILE_NAME);
    await fs.mkdir(settings.pm2Home, { recursive: true, mode: 0o700 });
    try {
      token = (await fs.readFile(tokenPath, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (!token) {
      token = randomBytes(32).toString('base64url');
      await fs.writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
      await fs.chmod(tokenPath, 0o600);
    }
    return token;
  };

  const launchURL = async () =>
    settings.noAuth
      ? settings.baseURL
      : `${settings.baseURL}/launch?token=${encodeURIComponent(await ensureToken())}`;

  const browserOpenCommand = (url: string) =>
    settings.skipBrowserOpen ? null : resolveBrowserOpenCommand(url);

  const openBrowser = async (isAlreadyRunning = false) => {
    const url = await launchURL();
    const openCommand = browserOpenCommand(url);
    console.log(`
PM2 Captain ${isAlreadyRunning ? 'is already running' : 'is ready'}.

  ${url}

${openCommand ? 'Opening the UI in your browser.' : 'Open the URL above to access the UI.'}
${settings.noAuth ? 'Captain authentication is disabled.' : ''}
${isAlreadyRunning ? '' : 'Press Ctrl+C to stop Captain.'}
`);
    if (!openCommand) {
      return;
    }
    const [command, args] = openCommand;
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', error => {
      log.warn({ error, command }, 'Failed to open PM2 Captain in the browser');
    });
    child.unref();
  };

  const isPortOccupied = () =>
    new Promise<boolean>(resolve => {
      const socket = libNet.createConnection(settings.port, settings.host);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });

  const waitForPortRelease = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!(await isPortOccupied())) {
        return true;
      }
    }
    return false;
  };

  return new (class CaptainLauncher implements IAppLifecycleMethods {
    initialize = async () => {
      if (!settings.noAuth) {
        await ensureToken();
      }
    };

    start = async (waitFor: IAppWaitForMethod) => {
      await waitFor('webServer');
      await openBrowser();
    };

    openExistingIfRunning = async () => {
      if (!(await isPortOccupied())) {
        return false;
      }
      let isExistingCaptain = false;
      try {
        const response = await fetch(`${settings.baseURL}/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        const health = await response.json();
        isExistingCaptain =
          typeof health === 'object' &&
          health !== null &&
          'name' in health &&
          health.name === 'pm2-captain';
      } catch {
        // The diagnostic below is more useful than the fetch error.
      }
      if (isExistingCaptain) {
        // PM2/self-restart and tsx watch can start the replacement before the
        // previous Captain has released its listener. Wait briefly for that
        // before treating the occupied port as a live singleton instance.
        if (await waitForPortRelease()) {
          return false;
        }
        await openBrowser(true);
        return true;
      }
      throw new PortConflictError(
        `Port ${settings.port} is already in use by another application. Use --port <number>.`
      );
    };

    authenticate = (candidate: string | undefined) => {
      if (settings.noAuth) {
        return true;
      }
      if (!candidate || !token) {
        return false;
      }
      const left = Buffer.from(candidate);
      const right = Buffer.from(token);
      return left.length === right.length && timingSafeEqual(left, right);
    };
  })();
}

export default define({
  createCaptainLauncher,
});
