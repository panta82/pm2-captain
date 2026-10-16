import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let root: string;
let configDir: string;
let server: ChildProcessWithoutNullStreams;
let backend: { baseURL: string; token: string; identifiers: string[] };

beforeAll(async () => {
  root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2-captain-desktop-runtime-'));
  configDir = libPath.join(root, 'config');
  server = spawn(
    process.execPath,
    ['--import', 'tsx', libPath.resolve('tests/support/desktop_runtime_server.ts'), configDir],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  backend = await new Promise((resolve, reject) => {
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      const line = output.split('\n').find(candidate => candidate.startsWith('{"baseURL"'));
      if (line) {
        resolve(JSON.parse(line));
      }
    });
    server.once('exit', code => reject(new Error(`The backend exited (${code}): ${output}`)));
  });
}, 60_000);

afterAll(async () => {
  if (server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.stdin.end();
    await exited;
  }
  await fs.rm(root, { recursive: true, force: true });
});

const list = (headers: Record<string, string> = {}) =>
  fetch(`${backend.baseURL}/api/trpc/processes.list`, { headers });

const login = async () => {
  const launch = await fetch(
    `${backend.baseURL}/launch?token=${encodeURIComponent(backend.token)}`,
    {
      redirect: 'manual',
    }
  );
  expect(launch.status).toBe(302);
  return launch;
};

describe('desktop backend runtime', () => {
  it('listens on an OS-assigned loopback port and has no browser launch policy', async () => {
    expect(backend.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(backend.baseURL).not.toMatch(/:0$/);
    expect(backend.identifiers).not.toContain('captainLauncher');
    await expect((await fetch(`${backend.baseURL}/health`)).json()).resolves.toMatchObject({
      name: 'pm2-captain',
      runtime: 'desktop',
      fake: true,
    });
  });

  it('authenticates with its own in-memory token and checks the bound origin', async () => {
    expect((await list()).status).toBe(401);
    expect(
      (await fetch(`${backend.baseURL}/launch?token=wrong`, { redirect: 'manual' })).status
    ).toBe(401);

    const launch = await login();
    const setCookie = launch.headers.get('set-cookie')!;
    const cookie = setCookie.split(';', 1)[0];
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);

    expect((await list({ cookie, origin: backend.baseURL })).status).toBe(200);
    // The configured URL has port 0; only the real origin is accepted.
    expect((await list({ cookie, origin: 'http://127.0.0.1:0' })).status).toBe(403);
    expect((await list({ cookie, origin: 'http://127.0.0.1:3212' })).status).toBe(403);
    // The npm launch token and tab records are left alone.
    await expect(fs.readdir(configDir)).rejects.toThrow();
  });

  it('refuses command-line daemon handoffs', async () => {
    const response = await fetch(`${backend.baseURL}/launch/daemon`, {
      method: 'POST',
      headers: { authorization: `Bearer ${backend.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'local', pm2Home: '/tmp/pm2' }),
    });

    expect(response.status).toBe(404);
  });
});
