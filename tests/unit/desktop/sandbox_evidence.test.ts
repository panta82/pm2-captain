import { describe, expect, it } from 'vitest';

// @ts-expect-error A plain ES module script without types.
import { assessSandbox } from '../../../support/desktop/sandbox-evidence.mjs';

const SANDBOXED_STATUS = 'Name:\tpm2-captain-des\nNSpid:\t4321\t3\nSeccomp:\t2\n';
const processes = [
  { pid: 100, args: '/opt/PM2 Captain/pm2-captain-desktop --remote-debugging-port=9333' },
  { pid: 101, args: '/opt/PM2 Captain/pm2-captain-desktop --type=zygote' },
  { pid: 4321, args: '/opt/PM2 Captain/pm2-captain-desktop --type=renderer --lang=en-US' },
];

const assess = (overrides: Record<string, unknown> = {}) =>
  assessSandbox({
    processes,
    readStatus: () => SANDBOXED_STATUS,
    platform: 'linux',
    log: '2026-10-15T20:48:17Z INFO Backend ready',
    ...overrides,
  });

describe('sandbox evidence', () => {
  it('accepts renderers in their own PID namespace under seccomp', () => {
    expect(assess()).toEqual([]);
  });

  it('catches --no-sandbox added by a launcher, even when the app started', () => {
    const problems = assess({
      processes: [
        ...processes,
        { pid: 102, args: '/tmp/.mount_x/pm2-captain-desktop.bin --no-sandbox' },
      ],
    });
    expect(problems).toEqual(['process 102 runs with --no-sandbox']);
  });

  it('catches the warning the app logs when it runs without the sandbox', () => {
    expect(assess({ log: 'WARN Running without the Chromium sandbox' })).toHaveLength(1);
  });

  it('does not take a sandbox preference as proof: the renderer must be isolated', () => {
    expect(assess({ readStatus: () => 'NSpid:\t4321\nSeccomp:\t2\n' })).toEqual([
      'renderer 4321 is not in a sandbox PID namespace',
    ]);
    expect(assess({ readStatus: () => 'NSpid:\t4321\t3\nSeccomp:\t0\n' })).toEqual([
      'renderer 4321 has no seccomp-bpf filter',
    ]);
    expect(assess({ processes: processes.slice(0, 2) })).toEqual(['no renderer process was found']);
  });
});
