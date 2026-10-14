import { describe, expect, it } from 'vitest';

import { processLink } from '../../../../src/frontend/lib/process_route';

describe('processLink', () => {
  it('keeps the tab of one process', () => {
    expect(processLink('daemon', [3], 'logs').params).toEqual({
      daemonId: 'daemon',
      pmIds: [3],
      tab: 'logs',
    });
  });

  it('opens Info for a selection that would be on Logs', () => {
    expect(processLink('daemon', [1, 2], 'logs').params.tab).toBe('info');
    expect(processLink('daemon', [1, 2], 'env').params.tab).toBe('env');
  });
});
