import { describe, expect, it } from 'vitest';

import {
  bulkActionTargets,
  formatPmIds,
  parsePmIds,
  selectRange,
  toggleSelection,
} from '../../../../src/frontend/lib/process_selection';
import type { IProcessStatus, IProcessSummary } from '../../../../src/shared/contracts';

function process(pmId: number, status: IProcessStatus, isCaptain = false): IProcessSummary {
  return {
    daemonId: 'daemon',
    pmId,
    name: `app-${pmId}`,
    namespace: 'default',
    status,
    pid: null,
    mode: 'fork',
    cpu: null,
    memory: null,
    uptime: null,
    restarts: 0,
    unstableRestarts: 0,
    version: null,
    watching: false,
    isCaptain,
  };
}

describe('parsePmIds', () => {
  it('reads one ID and a selection of several', () => {
    expect(parsePmIds('7')).toEqual([7]);
    expect(parsePmIds('0,2,11')).toEqual([0, 2, 11]);
  });

  it('gives one selection one order, without repeats', () => {
    expect(parsePmIds('3,1,3,2')).toEqual([1, 2, 3]);
    expect(formatPmIds([3, 1, 3, 2])).toBe('1,2,3');
  });

  it('rejects anything that is not a list of PM2 IDs', () => {
    for (const param of ['', 'abc', '1,', ',1', '1,,2', '1.5', '-1', '1, 2', '1e3', '0x10']) {
      expect(parsePmIds(param), param).toEqual([]);
    }
  });
});

describe('toggleSelection', () => {
  it('adds a process and removes a selected one', () => {
    expect(toggleSelection([1, 2], 5)).toEqual([1, 2, 5]);
    expect(toggleSelection([1, 2, 5], 2)).toEqual([1, 5]);
  });

  it('keeps the last selected process', () => {
    expect(toggleSelection([4], 4)).toEqual([4]);
  });
});

describe('selectRange', () => {
  // The order of the list, not of the IDs, decides what lies in between.
  const listed = [8, 3, 5, 1, 9];

  it('takes everything between the anchor and the target, in either direction', () => {
    expect(selectRange(listed, 3, 1)).toEqual([3, 5, 1]);
    expect(selectRange(listed, 1, 3)).toEqual([3, 5, 1]);
    expect(selectRange(listed, 5, 5)).toEqual([5]);
  });

  it('falls back to the target when a filter hides the anchor', () => {
    expect(selectRange(listed, 42, 5)).toEqual([5]);
  });
});

describe('bulkActionTargets', () => {
  const online = process(0, 'online');
  const stopped = process(1, 'stopped');
  const errored = process(2, 'errored');
  const captain = process(3, 'online', true);
  const selection = [online, stopped, errored, captain];

  it('starts only what is not running', () => {
    expect(bulkActionTargets('start', selection)).toEqual([stopped, errored]);
  });

  it('restarts only what is running, Captain included', () => {
    expect(bulkActionTargets('restart', selection)).toEqual([online, captain]);
  });

  it('never stops Captain', () => {
    expect(bulkActionTargets('stop', selection)).toEqual([online]);
    expect(bulkActionTargets('stop', [captain])).toEqual([]);
  });
});
