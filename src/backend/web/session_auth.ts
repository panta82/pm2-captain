import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import libPath from 'node:path';

import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IAppLifecycleMethods } from '../lib/app';

const TOKEN_FILE_NAME = 'launch-token';

/**
 * Owns the launch token that /launch exchanges for a session cookie. The CLI
 * keeps it in the config directory, so a command-line handoff can authenticate
 * and an open tab survives a restart. A desktop backend makes a fresh one for
 * each run and never touches that file; its parent receives it privately.
 */
export function createSessionAuth({ settings }: IContainer) {
  let token = '';

  const ensureToken = async () => {
    if (token) {
      return token;
    }
    if (settings.runtime === 'desktop') {
      token = randomBytes(32).toString('base64url');
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

  return new (class SessionAuth implements IAppLifecycleMethods {
    initialize = async () => {
      if (!settings.noAuth) {
        await ensureToken();
      }
    };

    ensureToken = ensureToken;

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
  createSessionAuth,
});
