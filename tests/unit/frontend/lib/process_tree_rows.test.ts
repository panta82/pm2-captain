import { describe, expect, it } from 'vitest';

import {
  type ITreeRow,
  buildTreeRows,
  findFilterMatches,
  sumProcesses,
} from '../../../../src/frontend/lib/process_tree_rows';
import type { IDaemonSummary, IProcessSummary } from '../../../../src/shared/contracts';

function daemon(daemonId: string): IDaemonSummary {
  return {
    daemonId,
    connectionId: `${daemonId}-connection`,
    kind: 'local',
    label: daemonId,
    color: null,
    hostname: null,
    username: null,
    status: 'online',
    error: null,
    lastSeenAt: null,
  };
}

function process(
  daemonId: string,
  pmId: number,
  fields: Partial<IProcessSummary> = {}
): IProcessSummary {
  return {
    daemonId,
    connectionId: `${daemonId}-connection`,
    pmId,
    name: `${daemonId}-${pmId}`,
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

const DAEMONS = [daemon('alpha'), daemon('beta')];
const PROCESSES = [
  process('alpha', 0, { cpu: 1 }),
  process('alpha', 1, { cpu: 9 }),
  process('beta', 0, { cpu: 5 }),
];

const build = (overrides: Partial<Parameters<typeof buildTreeRows>[0]> = {}) =>
  buildTreeRows({
    daemons: DAEMONS,
    processes: PROCESSES,
    filterMatches: null,
    isDaemonOpen: () => true,
    closedWhileFiltering: new Set(),
    selection: null,
    sort: null,
    ...overrides,
  });

const keysOf = (rows: ITreeRow[]) => rows.map(row => row.key);

describe('buildTreeRows', () => {
  it('lists each daemon followed by its own processes', () => {
    expect(keysOf(build())).toEqual([
      'daemon:alpha',
      'process:alpha:0',
      'process:alpha:1',
      'daemon:beta',
      'process:beta:0',
    ]);
  });

  it('keeps PM2 IDs of different daemons apart', () => {
    const rows = build().filter(row => row.kind === 'process');
    expect(new Set(keysOf(rows)).size).toBe(3);
  });

  it('shows a collapsed daemon as its row alone, still counting all its processes', () => {
    const rows = build({ isDaemonOpen: daemonId => daemonId !== 'alpha' });
    expect(keysOf(rows)).toEqual(['daemon:alpha', 'daemon:beta', 'process:beta:0']);
    expect(rows[0].kind === 'daemon' && rows[0].processes).toHaveLength(2);
  });

  it('keeps a daemon without processes in the tree', () => {
    const rows = build({ daemons: [daemon('empty')], processes: [] });
    expect(keysOf(rows)).toEqual(['daemon:empty']);
  });

  it('sorts inside each daemon, and leaves the daemons in their order', () => {
    const rows = build({ sort: { key: 'cpu', isDescending: true } });
    expect(keysOf(rows)).toEqual([
      'daemon:alpha',
      'process:alpha:1',
      'process:alpha:0',
      'daemon:beta',
      'process:beta:0',
    ]);
  });

  describe('while filtering', () => {
    const betaOnly = PROCESSES.filter(item => item.daemonId === 'beta');
    const matches = (processes: IProcessSummary[], daemonIds: string[] = []) => ({
      processes,
      daemonIds: new Set(daemonIds),
    });

    it('drops daemons without a match, and opens the ones with a match', () => {
      const rows = build({ filterMatches: matches(betaOnly), isDaemonOpen: () => false });
      expect(keysOf(rows)).toEqual(['daemon:beta', 'process:beta:0']);
    });

    it('keeps a daemon closed that was closed during this filter', () => {
      const rows = build({
        filterMatches: matches(PROCESSES),
        closedWhileFiltering: new Set(['alpha']),
      });
      expect(keysOf(rows)).toEqual(['daemon:alpha', 'daemon:beta', 'process:beta:0']);
    });

    it('keeps a daemon whose own name matches, also without processes', () => {
      const rows = build({
        daemons: [daemon('empty'), ...DAEMONS],
        filterMatches: matches([], ['empty']),
      });
      expect(keysOf(rows)).toEqual(['daemon:empty']);
    });

    it('keeps the selected processes, which the open page acts on', () => {
      const rows = build({
        filterMatches: matches([]),
        selection: { daemonId: 'alpha', pmIds: [1] },
      });
      expect(keysOf(rows)).toEqual(['daemon:alpha', 'process:alpha:1']);
    });

    it('does not keep the same PM2 ID of another daemon', () => {
      const rows = build({
        filterMatches: matches([]),
        selection: { daemonId: 'beta', pmIds: [0] },
      });
      expect(keysOf(rows)).toEqual(['daemon:beta', 'process:beta:0']);
    });

    it('leaves nothing when nothing matches', () => {
      expect(build({ filterMatches: matches([]) })).toEqual([]);
    });
  });
});

describe('findFilterMatches', () => {
  const find = (matchingProcesses: IProcessSummary[], highlight: RegExp | null) =>
    findFilterMatches({ daemons: DAEMONS, processes: PROCESSES, matchingProcesses, highlight });

  it('takes along all the processes of a daemon whose own name matches', () => {
    const { daemonIds, processes } = find([], /alpha/g);
    expect([...daemonIds]).toEqual(['alpha']);
    expect(processes.map(item => item.daemonId)).toEqual(['alpha', 'alpha']);
  });

  it('adds up a daemon match and the processes that match elsewhere', () => {
    const beta = PROCESSES[2];
    expect(find([beta], /alpha/g).processes).toEqual(PROCESSES);
  });

  it('tests every daemon from the start, although the expression is global', () => {
    expect([...find([], /a/g).daemonIds]).toEqual(['alpha', 'beta']);
  });

  it('finds nothing with an expression that does not compile', () => {
    const { daemonIds, processes } = find([], null);
    expect(daemonIds.size).toBe(0);
    expect(processes).toEqual([]);
  });
});

describe('sumProcesses', () => {
  it('totals online CPU and memory and counts all restarts', () => {
    expect(
      sumProcesses([
        process('alpha', 0, { cpu: 2.5, memory: 100, restarts: 3 }),
        process('alpha', 1, { cpu: 1, memory: 50, restarts: 0 }),
        // Ignore stale CPU and memory values on stopped processes.
        process('alpha', 2, { status: 'stopped', cpu: 40, memory: 900, restarts: 7 }),
        process('alpha', 3, { cpu: null, memory: null }),
      ])
    ).toEqual({ online: 3, offline: 1, cpu: 3.5, memory: 150, restarts: 10 });
  });
});
