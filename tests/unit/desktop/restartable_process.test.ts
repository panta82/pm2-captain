import { ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error A plain ES module script without types.
import { createRestartableProcess } from '../../../support/desktop/restartable_process.mjs';

const STOP_LIMIT_MS = 300;
const children: ChildProcess[] = [];

/** A child that ignores SIGTERM, as a hung app does; only SIGKILL ends it. */
const stubborn = () => {
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );
  children.push(child);
  return child;
};
const ready = (child: ChildProcess) => new Promise(resolve => child.stdout?.once('data', resolve));
const isRunning = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

afterEach(() => {
  for (const child of children.splice(0)) {
    if (isRunning(child)) {
      child.kill('SIGKILL');
    }
  }
});

describe('createRestartableProcess', () => {
  it('kills a child that ignores SIGTERM when restarting, and starts the next', async () => {
    const start = vi.fn(stubborn);
    const runner = createRestartableProcess({ start, stopLimitMs: STOP_LIMIT_MS, onExit: vi.fn() });
    await runner.restart();
    const first = start.mock.results[0].value as ChildProcess;
    await ready(first);

    const startedAt = Date.now();
    await runner.restart();

    expect(first.signalCode).toBe('SIGKILL');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(STOP_LIMIT_MS - 50);
    expect(start).toHaveBeenCalledTimes(2);
    await runner.stop();
  });

  it('ends a restart under way when stopped, within the limit, and starts nothing', async () => {
    const start = vi.fn(stubborn);
    const onExit = vi.fn();
    const runner = createRestartableProcess({ start, stopLimitMs: STOP_LIMIT_MS, onExit });
    await runner.restart();
    const first = start.mock.results[0].value as ChildProcess;
    await ready(first);

    const startedAt = Date.now();
    const restarting = runner.restart();
    await new Promise(resolve => setTimeout(resolve, 50));
    // Repeated signals call stop() again; all of them share the one stop.
    await Promise.all([runner.stop(), runner.stop(), restarting]);

    expect(Date.now() - startedAt).toBeLessThan(STOP_LIMIT_MS + 1_000);
    expect(first.signalCode).toBe('SIGKILL');
    expect(start).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();

    await runner.restart();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('reports a child that exits by itself', async () => {
    const onExit = vi.fn();
    const runner = createRestartableProcess({
      start: () => {
        const child = spawn(process.execPath, ['-e', 'process.exit(3)']);
        children.push(child);
        return child;
      },
      stopLimitMs: STOP_LIMIT_MS,
      onExit,
    });
    await runner.restart();

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(3, null));
  });
});
