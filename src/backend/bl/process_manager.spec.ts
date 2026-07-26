import { describe, expect, it, vi } from 'vitest';

import { createProcessManager } from './process_manager';

function description(overrides: Record<string, unknown> = {}) {
  return {
    pid: 100,
    name: 'fixture',
    monit: { cpu: 1.5, memory: 1024 },
    pm2_env: {
      pm_id: 4,
      name: 'fixture',
      namespace: 'default',
      status: 'online',
      exec_mode: 'fork_mode',
      pm_uptime: Date.now() - 1_000,
      restart_time: 2,
      unstable_restarts: 1,
      version: '1.2.3',
      watch: false,
      pm_exec_path: '/tmp/fixture.js',
      args: ['--safe'],
      pm_cwd: '/tmp',
      exec_interpreter: 'node',
      node_version: '22.0.0',
      instances: 1,
      created_at: 100,
      exit_code: 0,
      cron_restart: null,
      pm_out_log_path: '/tmp/out.log',
      pm_err_log_path: '/tmp/err.log',
      ...overrides,
    },
  };
}

function setup(item = description()) {
  const pm2Client = {
    list: vi.fn().mockResolvedValue([item]),
    describe: vi.fn().mockResolvedValue([item]),
    startProcess: vi.fn().mockResolvedValue(undefined),
    stopProcess: vi.fn().mockResolvedValue(undefined),
    restartProcess: vi.fn().mockResolvedValue(undefined),
  };
  const manager = createProcessManager({
    pm2Client,
    log: { info: vi.fn(), error: vi.fn() },
  } as never);
  return { manager, pm2Client };
}

describe('processManager', () => {
  it('normalizes only the public status fields', async () => {
    const { manager } = setup(
      description({ SECRET_VALUE: 'must-not-leak', env: { PASSWORD: 'nope' } })
    );
    const result = await manager.list();

    expect(result.processes[0]).toMatchObject({
      pmId: 4,
      name: 'fixture',
      status: 'online',
      mode: 'fork',
      restarts: 2,
      memory: 1024,
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('PASSWORD');
  });

  it('rejects stopping Captain itself before invoking PM2', async () => {
    const item = description();
    item.pid = process.pid;
    const { manager, pm2Client } = setup(item);

    await expect(manager.action(4, 'stop')).rejects.toThrow('PM2 Captain cannot stop itself');
    expect(pm2Client.stopProcess).not.toHaveBeenCalled();
  });

  it('serializes conflicting lifecycle actions for one PM2 id', async () => {
    let release!: () => void;
    const { manager, pm2Client } = setup();
    pm2Client.restartProcess.mockImplementation(
      () => new Promise<void>(resolve => (release = resolve))
    );

    const restart = manager.action(4, 'restart');
    await vi.waitFor(() => expect(pm2Client.restartProcess).toHaveBeenCalledOnce());
    const stop = manager.action(4, 'stop');
    await Promise.resolve();
    expect(pm2Client.stopProcess).not.toHaveBeenCalled();
    release();
    await Promise.all([restart, stop]);
    expect(pm2Client.stopProcess).toHaveBeenCalledOnce();
  });

  it('accepts a Captain self-restart before scheduling the PM2 action', async () => {
    vi.useFakeTimers();
    const item = description();
    item.pid = process.pid;
    const { manager, pm2Client } = setup(item);

    const result = await manager.action(4, 'restart');

    expect(result).toEqual({ accepted: true, reconnecting: true });
    expect(pm2Client.restartProcess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(350);
    expect(pm2Client.restartProcess).toHaveBeenCalledWith(4);
    vi.useRealTimers();
  });
});
