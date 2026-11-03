import { describe, expect, it } from 'vitest';

import {
  type IProcessSort,
  chooseProcessSort,
  cycleProcessSort,
  formatProcessSort,
  parseProcessSort,
  sortProcesses,
} from '../../../../src/frontend/lib/process_sort';
import type { IProcessSummary } from '../../../../src/shared/contracts';

function process(pmId: number, fields: Partial<IProcessSummary> = {}): IProcessSummary {
  return {
    daemonId: 'daemon',
    connectionId: 'connection',
    pmId,
    name: `app-${pmId}`,
    namespace: 'default',
    status: 'online',
    pid: 1000 + pmId,
    mode: 'fork',
    cpu: 1,
    memory: 1,
    uptime: 1,
    restarts: 0,
    unstableRestarts: 0,
    version: null,
    watching: false,
    isCaptain: false,
    ...fields,
  };
}

const idsAfter = (processes: IProcessSummary[], sort: IProcessSort | null) =>
  sortProcesses(processes, sort).map(item => item.pmId);

describe('sortProcesses', () => {
  it('keeps the order PM2 reports without a sort', () => {
    const processes = [process(3), process(1), process(2)];
    expect(idsAfter(processes, null)).toEqual([3, 1, 2]);
  });

  it('keeps missing CPU values last in both sort directions', () => {
    const processes = [
      process(0, { cpu: null }),
      process(1, { cpu: 5 }),
      process(2, { cpu: 50 }),
      process(3, { cpu: null }),
    ];
    expect(idsAfter(processes, { key: 'cpu', isDescending: true })).toEqual([2, 1, 0, 3]);
    expect(idsAfter(processes, { key: 'cpu', isDescending: false })).toEqual([1, 2, 0, 3]);
  });

  it('keeps a process without a version last, like any empty value', () => {
    const processes = [
      process(0, { version: null }),
      process(1, { version: '2.0.0' }),
      process(2, { version: '10.0.0' }),
    ];
    expect(idsAfter(processes, { key: 'version', isDescending: false })).toEqual([1, 2, 0]);
    expect(idsAfter(processes, { key: 'version', isDescending: true })).toEqual([2, 1, 0]);
  });

  it('reads the numbers in names, and ignores case', () => {
    const processes = [
      process(0, { name: 'worker-10' }),
      process(1, { name: 'Worker-2' }),
      process(2, { name: 'api' }),
    ];
    expect(idsAfter(processes, { key: 'name', isDescending: false })).toEqual([2, 1, 0]);
  });

  it('puts online processes first when sorting by status', () => {
    const processes = [
      process(0, { status: 'stopped' }),
      process(1, { status: 'errored' }),
      process(2, { status: 'online' }),
    ];
    expect(idsAfter(processes, { key: 'status', isDescending: false })).toEqual([2, 0, 1]);
  });

  it('settles equal values by PM2 ID, so a live sort does not shuffle them', () => {
    const processes = [process(2), process(0), process(1)];
    expect(idsAfter(processes, { key: 'cpu', isDescending: true })).toEqual([0, 1, 2]);
    expect(idsAfter(processes, { key: 'cpu', isDescending: false })).toEqual([0, 1, 2]);
  });

  it('does not mutate the input list', () => {
    const processes = [process(1, { cpu: 1 }), process(0, { cpu: 9 })];
    sortProcesses(processes, { key: 'cpu', isDescending: true });
    expect(processes.map(item => item.pmId)).toEqual([1, 0]);
  });
});

describe('cycleProcessSort', () => {
  it('cycles numeric sorting from descending to ascending to PM2 order', () => {
    const first = cycleProcessSort(null, 'cpu');
    expect(first).toEqual({ key: 'cpu', isDescending: true });
    const second = cycleProcessSort(first, 'cpu');
    expect(second).toEqual({ key: 'cpu', isDescending: false });
    expect(cycleProcessSort(second, 'cpu')).toBeNull();
  });

  it('sorts text in ascending order first', () => {
    const first = cycleProcessSort(null, 'namespace');
    expect(first).toEqual({ key: 'namespace', isDescending: false });
    expect(cycleProcessSort(first, 'namespace')).toEqual({ key: 'namespace', isDescending: true });
  });

  it('starts over on another column', () => {
    expect(cycleProcessSort({ key: 'cpu', isDescending: false }, 'memory')).toEqual({
      key: 'memory',
      isDescending: true,
    });
  });
});

describe('chooseProcessSort', () => {
  it('flips the current key instead of ending the sort', () => {
    const first = chooseProcessSort(null, 'name');
    expect(first).toEqual({ key: 'name', isDescending: false });
    const second = chooseProcessSort(first, 'name');
    expect(second).toEqual({ key: 'name', isDescending: true });
    expect(chooseProcessSort(second, 'name')).toEqual({ key: 'name', isDescending: false });
  });
});

describe('a remembered sort', () => {
  it('survives being written and read', () => {
    const sort: IProcessSort = { key: 'memory', isDescending: true };
    expect(parseProcessSort(formatProcessSort(sort))).toEqual(sort);
    expect(parseProcessSort(formatProcessSort(null))).toBeNull();
  });

  it('falls back to PM2 order for anything it does not know', () => {
    for (const value of [null, '', 'cpu', 'cpu:sideways', 'colour:asc', ':asc']) {
      expect(parseProcessSort(value)).toBeNull();
    }
  });
});
