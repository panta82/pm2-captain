import { describe, expect, it } from 'vitest';

import {
  buildProcessSearchRegex,
  matchesProcess,
} from '../../../../src/frontend/lib/process_list_filter';
import type { IProcessSummary } from '../../../../src/shared/contracts';

const PROCESS: IProcessSummary = {
  daemonId: 'local',
  connectionId: 'local-connection',
  pmId: 6,
  name: 'aup-git-nanny-work',
  namespace: 'infra',
  status: 'online',
  pid: 4000,
  mode: 'fork',
  cpu: 1,
  memory: 1,
  uptime: 1,
  restarts: 0,
  unstableRestarts: 0,
  version: '1.0.0',
  watching: false,
  isCaptain: false,
};

const searchRegex = (search: string, regex = false) =>
  buildProcessSearchRegex(search, { caseSensitive: false, regex });
const matches = (search: string, regex = false) =>
  matchesProcess(PROCESS, searchRegex(search, regex) as RegExp);

describe('matchesProcess', () => {
  it('finds a process by any of its fields, the status included', () => {
    expect(matches('nanny')).toBe(true);
    expect(matches('infra')).toBe(true);
    expect(matches('online')).toBe(true);
    expect(matches('4000')).toBe(true);
  });

  it('finds the words of plain text in order, with anything between them', () => {
    expect(matches('aup dev')).toBe(false);
    expect(matches('aup nanny')).toBe(true);
    expect(matches('git   work')).toBe(true);
    expect(matches('work git')).toBe(false);
    expect('aup-backend-dev'.match(searchRegex('aup dev') as RegExp)).toEqual(['aup-backend-dev']);
  });

  it('takes special characters in plain text literally', () => {
    expect(matches('nanny.work')).toBe(false);
    expect(matches('1.0.0')).toBe(true);
  });

  it('ignores spaces around plain text, and has no filter without words', () => {
    expect(matches(' work ')).toBe(true);
    expect(searchRegex('   ')).toBeNull();
  });

  it('does not match across two fields, where nothing could be highlighted', () => {
    expect(matches('work infra')).toBe(false);
  });

  it('anchors an expression to each field', () => {
    expect(matches('^aup', true)).toBe(true);
    expect(matches('work$', true)).toBe(true);
    expect(matches('^infra$', true)).toBe(true);
  });
});
