import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs, readFileSync } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BackendStartError,
  createBackendHost,
  ownedGroupMembers,
  parseElapsed,
} from '../../../../src/desktop/main/backend_host';
import type { IBackendRequest } from '../../../../src/desktop/shared/backend_protocol';

const TOKEN = 'x'.repeat(43);

/** Behaves like Electron's UtilityProcess as far as the host uses it. */
class FakeBackend extends EventEmitter {
  pid: number | undefined = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  requests: IBackendRequest[] = [];
  kill = vi.fn(() => true);
  postMessage = (request: IBackendRequest) => {
    this.requests.push(request);
    this.onRequest(request);
  };
  onRequest: (request: IBackendRequest) => void = () => undefined;
  exit(code: number) {
    this.pid = undefined;
    this.emit('exit', code);
  }
}

const leftovers: ChildProcess[] = [];

/** False once the process is gone and reaped. */
function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // A zombie still answers signal 0 until its parent reaps it.
    return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z');
  } catch {
    return false;
  }
}
let root: string | null = null;

afterEach(async () => {
  for (const child of leftovers.splice(0)) {
    child.kill('SIGKILL');
  }
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
    root = null;
  }
});

function setup(behave: (backend: FakeBackend, request: IBackendRequest) => void) {
  const backend = new FakeBackend();
  backend.onRequest = request => behave(backend, request);
  const onUnexpectedExit = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), raw: vi.fn() };
  const host = createBackendHost({
    fork: vi.fn(() => backend as never),
    entryPath: '/app/dist/desktop/backend/desktop_backend.js',
    environment: { PATH: '/usr/bin' },
    backendOptions: () => ({
      configDir: '/config',
      environmentPm2Home: null,
      fakeScenario: 'basic',
      fakeControlFile: null,
      debug: false,
      serverDevMode: false,
    }),
    log: log as never,
    backendLog: log as never,
    onUnexpectedExit,
  });
  return { backend, host, onUnexpectedExit, log };
}

const ready = (backend: FakeBackend, request: IBackendRequest) => {
  if (request.type === 'start') {
    queueMicrotask(() =>
      backend.emit('message', {
        type: 'ready',
        runId: request.runId,
        baseURL: 'http://127.0.0.1:45713',
        launchToken: TOKEN,
      })
    );
  }
};

describe('backend host', () => {
  it('starts the backend and keeps its token private to main', async () => {
    const { host, backend, log } = setup(ready);

    const run = await host.start();

    expect(run).toMatchObject({ baseURL: 'http://127.0.0.1:45713', launchToken: TOKEN });
    expect(backend.requests[0]).toMatchObject({
      type: 'start',
      options: { fakeScenario: 'basic' },
    });
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(TOKEN);
  });

  it('relays the simulated update between the backend and main', async () => {
    const onFakeUpdate = vi.fn();
    const backend = new FakeBackend();
    backend.onRequest = request => ready(backend, request);
    const host = createBackendHost({
      fork: vi.fn(() => backend as never),
      entryPath: '/app/dist/desktop/backend/desktop_backend.js',
      environment: {},
      backendOptions: () => ({
        configDir: '/config',
        environmentPm2Home: null,
        fakeScenario: 'basic',
        fakeControlFile: null,
        debug: false,
        serverDevMode: false,
      }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), raw: vi.fn() } as never,
      backendLog: { raw: vi.fn() } as never,
      onUnexpectedExit: vi.fn(),
      onFakeUpdate,
    });
    await host.start();
    const state = {
      status: 'downloaded',
      currentVersion: '1.5.0',
      installKind: 'appimage',
      version: '9.9.9',
      percent: 100,
      disabledReason: null,
      error: null,
      requiresAuthorization: false,
    };

    backend.emit('message', { type: 'fake-update', state });
    host.sendFakeUpdateAction('install');

    expect(onFakeUpdate).toHaveBeenCalledWith(state);
    expect(backend.requests.at(-1)).toEqual({ type: 'fake-update-action', action: 'install' });
  });

  it('ignores messages that are malformed or from another run', async () => {
    const { host, backend } = setup((backend, request) => {
      if (request.type !== 'start') {
        return;
      }
      queueMicrotask(() => {
        backend.emit('message', {
          type: 'ready',
          runId: 'another-run',
          baseURL: 'http://127.0.0.1:1',
          launchToken: TOKEN,
        });
        backend.emit('message', {
          type: 'ready',
          runId: request.runId,
          baseURL: 'http://evil.example.com',
          launchToken: TOKEN,
        });
        ready(backend, request);
      });
    });

    await expect(host.start()).resolves.toMatchObject({ baseURL: 'http://127.0.0.1:45713' });
    expect(backend.listenerCount('message')).toBe(1);
  });

  it('reports a startup failure with its safe reason', async () => {
    const { host } = setup((backend, request) => {
      if (request.type === 'start') {
        queueMicrotask(() => {
          backend.emit('message', {
            type: 'failed',
            runId: request.runId,
            error: {
              code: 'REGISTRY_INVALID',
              message: 'daemons.json: bad',
              path: '/c/daemons.json',
            },
          });
          backend.exit(1);
        });
      }
    });

    const error = await host.start().catch(error => error);

    expect(error).toBeInstanceOf(BackendStartError);
    expect(error.startupError).toMatchObject({ code: 'REGISTRY_INVALID', path: '/c/daemons.json' });
  });

  it('stops by asking, and treats that exit as expected', async () => {
    const { host, backend, onUnexpectedExit } = setup((backend, request) => {
      ready(backend, request);
      if (request.type === 'stop') {
        queueMicrotask(() => backend.exit(0));
      }
    });
    await host.start();

    await host.stop();

    expect(backend.requests.map(request => request.type)).toEqual(['start', 'stop']);
    expect(backend.kill).not.toHaveBeenCalled();
    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(host.current).toBeNull();
  });

  it('kills a backend that does not stop in time', async () => {
    const { host, backend } = setup(ready);
    backend.kill.mockImplementation(() => {
      queueMicrotask(() => backend.exit(0));
      return true;
    });
    await host.start();

    await host.stop(50);

    expect(backend.kill).toHaveBeenCalledOnce();
  });

  /**
   * Starts a process group like the backend's SSH: a leader named "ssh" that
   * ends on SIGTERM, and a helper, like a ProxyCommand, that ignores it.
   */
  async function startSshGroup() {
    root ??= await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-owned-'));
    const fakeSsh = libPath.join(root, 'ssh');
    await fs.symlink('/bin/sh', fakeSsh).catch(() => undefined);
    const helperPidPath = libPath.join(root, `helper-${Date.now()}-${Math.random()}.pid`);
    const leader = spawn(
      fakeSsh,
      ['-c', `(trap '' TERM; exec sleep 600) & echo $! > "${helperPidPath}"; wait`],
      { detached: true, stdio: 'ignore' }
    );
    leftovers.push(leader);
    await vi.waitFor(() => fs.access(helperPidPath));
    const helper = Number(await fs.readFile(helperPidPath, 'utf8'));
    return { leader, helper };
  }

  const killGroup = (pid: number) => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  };

  it('ends all of an SSH group the backend left when it dies, before restarting', async () => {
    const { leader, helper } = await startSshGroup();
    const { host, backend, onUnexpectedExit } = setup(ready);
    await host.start();
    try {
      backend.emit('message', { type: 'owned-processes', pids: [leader.pid] });

      backend.exit(9);

      await vi.waitFor(() => expect(onUnexpectedExit).toHaveBeenCalledWith(9), { timeout: 8_000 });
      // The restart is only reported once the group, including the helper
      // that ignored SIGTERM, is gone.
      await vi.waitFor(() => expect(isAlive(leader.pid!)).toBe(false));
      await vi.waitFor(() => expect(isAlive(helper)).toBe(false));
    } finally {
      killGroup(leader.pid!);
    }
  }, 15_000);

  it('ends a surviving helper within an orderly stop', async () => {
    const { leader, helper } = await startSshGroup();
    const { host, backend } = setup((backend, request) => {
      ready(backend, request);
      if (request.type === 'stop') {
        // The backend stops its SSH leader; the helper ignores SIGTERM.
        queueMicrotask(() => {
          process.kill(-leader.pid!, 'SIGTERM');
          backend.exit(0);
        });
      }
    });
    await host.start();
    try {
      backend.emit('message', { type: 'owned-processes', pids: [leader.pid] });
      await new Promise(resolve => setTimeout(resolve, 300));

      await host.stop();

      await vi.waitFor(() => expect(isAlive(helper)).toBe(false), { timeout: 500 });
    } finally {
      killGroup(leader.pid!);
    }
  }, 15_000);

  it('lets a stop wait for a crash cleanup in progress, and then restarts nothing', async () => {
    const { leader, helper } = await startSshGroup();
    const { host, backend, onUnexpectedExit } = setup(ready);
    await host.start();
    try {
      backend.emit('message', { type: 'owned-processes', pids: [leader.pid] });
      await new Promise(resolve => setTimeout(resolve, 300));

      backend.exit(9);
      // The app quits while the crash is being cleaned up; the backend is already gone.
      await host.stop();

      // The helper ignores SIGTERM, so it is only gone if the stop waited for the KILL.
      await vi.waitFor(() => expect(isAlive(helper)).toBe(false), { timeout: 500 });
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(onUnexpectedExit).not.toHaveBeenCalled();
    } finally {
      killGroup(leader.pid!);
    }
  }, 15_000);

  it('ends what the backend left before a forced stop returns', async () => {
    const { leader, helper } = await startSshGroup();
    // The backend ignores the stop request and only exits when killed.
    const { host, backend } = setup(ready);
    backend.kill.mockImplementation(() => {
      queueMicrotask(() => backend.exit(0));
      return true;
    });
    await host.start();
    try {
      backend.emit('message', { type: 'owned-processes', pids: [leader.pid] });
      await new Promise(resolve => setTimeout(resolve, 300));

      await host.stop(50);

      expect(backend.kill).toHaveBeenCalled();
      await vi.waitFor(() => expect(isAlive(helper)).toBe(false), { timeout: 500 });
    } finally {
      killGroup(leader.pid!);
    }
  }, 15_000);

  it('never signals a reported process that is not an SSH group leader', async () => {
    const unrelated = spawn('/bin/sleep', ['600'], { detached: true, stdio: 'ignore' });
    leftovers.push(unrelated);
    const { host, backend, onUnexpectedExit } = setup(ready);
    await host.start();

    backend.emit('message', { type: 'owned-processes', pids: [unrelated.pid] });
    await new Promise(resolve => setTimeout(resolve, 300));
    backend.exit(9);

    await vi.waitFor(() => expect(onUnexpectedExit).toHaveBeenCalled());
    expect(isAlive(unrelated.pid!)).toBe(true);
  });
});

describe('owned SSH groups', () => {
  const group = { pgid: 100, leaderStartedAt: 1_000_000 };
  const row = (pid: number, pgid: number, startedAt: number) => ({
    pid,
    pgid,
    startedAt,
    command: 'ssh',
  });

  it('counts members while the leader is gone, but not processes that are older', () => {
    expect(
      ownedGroupMembers(group, [row(101, 100, 1_001_000), row(102, 100, 990_000), row(5, 5, 0)])
    ).toEqual([101]);
  });

  it('leaves a group alone when its leader PID belongs to a newer process', () => {
    expect(ownedGroupMembers(group, [row(100, 100, 1_500_000), row(101, 100, 1_501_000)])).toEqual(
      []
    );
    expect(ownedGroupMembers(group, [row(100, 100, 1_001_000), row(101, 100, 1_002_000)])).toEqual([
      100, 101,
    ]);
  });

  it('reads elapsed times across the day boundary', () => {
    expect(parseElapsed('05:07')).toBe(307);
    expect(parseElapsed('23:59:59')).toBe(86_399);
    expect(parseElapsed('1-00:00:00')).toBe(86_400);
    expect(parseElapsed('2-03:04:05')).toBe(183_845);
  });

  it('keeps a group whose leader crosses a day of running time between record and cleanup', () => {
    const recordedAt = 1_700_000_000_000;
    const leaderStartedAt = recordedAt - parseElapsed('23:59:59') * 1000;
    const cleanupAt = recordedAt + 1_000;
    const rows = [
      {
        pid: 100,
        pgid: 100,
        startedAt: cleanupAt - parseElapsed('1-00:00:00') * 1000,
        command: 'ssh',
      },
      {
        pid: 101,
        pgid: 100,
        startedAt: cleanupAt - parseElapsed('23:00:00') * 1000,
        command: 'sh',
      },
    ];

    expect(ownedGroupMembers({ pgid: 100, leaderStartedAt }, rows)).toEqual([100, 101]);
  });
});
