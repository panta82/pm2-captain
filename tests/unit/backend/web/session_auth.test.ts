import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionAuth } from '../../../../src/backend/web/session_auth';

let root: string;
let configDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2-captain-session-auth-'));
  configDir = libPath.join(root, 'config', 'pm2-captain');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const start = async (runtime: 'cli' | 'desktop') => {
  const auth = createSessionAuth({ settings: { configDir, noAuth: false, runtime } } as never);
  await auth.initialize();
  return auth;
};

describe('session auth', () => {
  it('keeps the CLI token in a private config directory across restarts', async () => {
    const auth = await start('cli');
    const tokenPath = libPath.join(configDir, 'launch-token');
    const token = (await fs.readFile(tokenPath, 'utf8')).trim();

    expect(token).toMatch(/^[\w-]{43}$/);
    expect((await fs.stat(configDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect(auth.authenticate(token)).toBe(true);
    expect(auth.authenticate(`${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`)).toBe(false);
    expect(auth.authenticate(undefined)).toBe(false);
    expect((await start('cli')).authenticate(token)).toBe(true);
  });

  it('gives each desktop run its own token and never reads or writes the CLI one', async () => {
    const cli = await start('cli');
    const cliToken = await cli.ensureToken();

    const first = await start('desktop');
    const second = await start('desktop');
    const firstToken = await first.ensureToken();

    expect(firstToken).toMatch(/^[\w-]{43}$/);
    expect(firstToken).not.toBe(cliToken);
    expect(await second.ensureToken()).not.toBe(firstToken);
    expect(first.authenticate(cliToken)).toBe(false);
    expect(first.authenticate(firstToken)).toBe(true);
    expect((await fs.readFile(libPath.join(configDir, 'launch-token'), 'utf8')).trim()).toBe(
      cliToken
    );
    expect(await fs.readdir(configDir)).toEqual(['launch-token']);
  });
});
