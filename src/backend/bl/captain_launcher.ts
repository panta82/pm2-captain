import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import libNet from 'node:net';
import libPath from 'node:path';
import { spawn } from 'node:child_process';

import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IAppLifecycleMethods, IAppWaitForMethod } from '../lib/app';

const TOKEN_FILE_NAME = 'pm2-captain-token';

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
    `${settings.baseURL}/launch?token=${encodeURIComponent(await ensureToken())}`;

  const canOpenBrowser = () =>
    !settings.skipBrowserOpen &&
    (process.platform === 'darwin' ||
      process.platform === 'win32' ||
      Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY));

  const openBrowser = async () => {
    const url = await launchURL();
    console.log(`PM2 Captain: ${url}`);
    if (!canOpenBrowser()) {
      return;
    }
    const [command, args] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', url]]
          : ['xdg-open', [url]];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
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

  return new (class CaptainLauncher implements IAppLifecycleMethods {
    initialize = async () => {
      await ensureToken();
    };

    start = async (waitFor: IAppWaitForMethod) => {
      await waitFor('webServer');
      await openBrowser();
    };

    openExistingIfRunning = async () => {
      if (!(await isPortOccupied())) {
        return false;
      }
      try {
        const response = await fetch(`${settings.baseURL}/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        const health = await response.json();
        if (health?.name === 'pm2-captain') {
          await openBrowser();
          return true;
        }
      } catch {
        // The diagnostic below is more useful than the fetch error.
      }
      throw new Error(
        `Port ${settings.port} is already in use by another application. Use --port <number>.`
      );
    };

    authenticate = (candidate: string | undefined) => {
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
