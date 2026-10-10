import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { accessSync, promises as fs, constants as fsConstants } from 'node:fs';
import libNet from 'node:net';
import libPath from 'node:path';

import { requestedDaemonInput } from '../backend_settings';
import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IAppLifecycleMethods, IAppWaitForMethod } from '../lib/app';

const TOKEN_FILE_NAME = 'launch-token';
/** Captains on different ports share the config directory, so the file is per port. */
const TAB_SEEN_FILE_PREFIX = 'tab-seen-';
/** A tab connected this recently before launch is assumed to still be open. */
const TAB_RECENT_MS = 60_000;
/**
 * How long a launch waits for such a tab before opening a new one. Browsers
 * retry a dropped event stream about every 3 seconds, hidden tabs included.
 */
const TAB_RECONNECT_WAIT_MS = 6_000;
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
  let openTabCount = 0;
  /** When a tab was last connected to this Captain, or null if none was yet. */
  let tabSeenAt: number | null = null;
  let tabReconnectTimer: NodeJS.Timeout | null = null;
  const tabSeenPath = libPath.join(settings.configDir, `${TAB_SEEN_FILE_PREFIX}${settings.port}`);

  const ensureToken = async () => {
    if (token) {
      return token;
    }
    const tokenPath = libPath.join(settings.configDir, TOKEN_FILE_NAME);
    await fs.mkdir(settings.configDir, { recursive: true, mode: 0o700 });
    await fs.chmod(settings.configDir, 0o700);
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
    settings.browserOpen === 'never' ? null : resolveBrowserOpenCommand(url);

  const wasTabSeenRecently = async () => {
    let content: string;
    try {
      content = await fs.readFile(tabSeenPath, 'utf8');
    } catch {
      return false;
    }
    // A malformed or future timestamp fails the range check and opens a tab.
    const elapsed = Date.now() - Number(content.trim());
    return elapsed >= 0 && elapsed < TAB_RECENT_MS;
  };

  const spawnBrowser = ([command, args]: IBrowserOpenCommand) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', error => {
      log.warn({ error, command }, 'Failed to open PM2 Captain in the browser');
    });
    child.unref();
  };

  const openBrowser = async (isAlreadyRunning = false) => {
    const url = await launchURL();
    const openCommand = browserOpenCommand(url);
    // A tab left over from the previous run reconnects by itself, so a restart
    // should not stack another one next to it.
    const shouldAwaitTab =
      !!openCommand &&
      !isAlreadyRunning &&
      settings.browserOpen === 'auto' &&
      (await wasTabSeenRecently());
    let openHint = 'Open the URL above to access the UI.';
    if (shouldAwaitTab) {
      openHint = 'Waiting for your open tab to reconnect.';
    } else if (openCommand) {
      openHint = 'Opening the UI in your browser.';
    }
    console.log(`
PM2 Captain ${isAlreadyRunning ? 'is already running' : 'is ready'}.

  ${url}

${openHint}
${settings.noAuth ? 'Captain authentication is disabled.' : ''}
${isAlreadyRunning ? '' : 'Press Ctrl+C to stop Captain.'}
`);
    if (!openCommand) {
      return;
    }
    if (!shouldAwaitTab) {
      spawnBrowser(openCommand);
      return;
    }
    tabReconnectTimer = setTimeout(() => {
      tabReconnectTimer = null;
      if (tabSeenAt === null) {
        console.log('No tab reconnected. Opening the UI in your browser.\n');
        spawnBrowser(openCommand);
      }
    }, TAB_RECONNECT_WAIT_MS);
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

  const handoffRequestedDaemon = async () => {
    const daemon = requestedDaemonInput(settings);
    if (!daemon) {
      return;
    }
    const launchToken = settings.noAuth ? '' : await ensureToken();
    const response = await fetch(`${settings.baseURL}/launch/daemon`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(launchToken ? { authorization: `Bearer ${launchToken}` } : {}),
      },
      body: JSON.stringify(daemon),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('The running PM2 Captain uses another launch token. Use another --port.');
      }
      const detail = (response.status === 400 ? await response.json().catch(() => null) : null) as {
        error?: unknown;
      } | null;
      throw new Error(
        typeof detail?.error === 'string'
          ? detail.error
          : `The running PM2 Captain could not add the requested daemon (${response.status}).`
      );
    }
    const result = (await response.json()) as { added?: boolean; daemon?: { label?: string } };
    console.log(
      result.added
        ? `Added ${result.daemon?.label || 'the requested daemon'} to the running Captain.`
        : `${result.daemon?.label || 'The requested daemon'} is already configured.`
    );
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

    stop = async () => {
      if (tabReconnectTimer) {
        clearTimeout(tabReconnectTimer);
        tabReconnectTimer = null;
      }
      // The web server stops first and drops every stream, so by now a tab
      // that was connected is only visible through its release time. When no
      // tab connected during this run, the previous run's record still stands.
      const seenAt = openTabCount > 0 ? Date.now() : tabSeenAt;
      if (seenAt === null) {
        return;
      }
      await fs.mkdir(settings.configDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(tabSeenPath, `${seenAt}\n`, { mode: 0o600 });
      await fs.chmod(tabSeenPath, 0o600);
    };

    /**
     * Counts a browser tab as connected until the returned function is called.
     */
    trackTab = () => {
      openTabCount++;
      tabSeenAt = Date.now();
      return () => {
        openTabCount--;
        tabSeenAt = Date.now();
      };
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
        await handoffRequestedDaemon();
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
