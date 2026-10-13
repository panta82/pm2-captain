import { describe, expect, it, vi } from 'vitest';

import { createLogManager } from '../../../../src/backend/bl/log_manager';

const detail = {
  pmId: 1,
  name: 'fixture',
  outLogPath: '/tmp/out.log',
  errLogPath: '/tmp/err.log',
};

describe('logManager', () => {
  it('does not reread an exhausted channel while paging combined history', async () => {
    const readPreviousLines = vi.fn(async (path: string, cursor: unknown) => {
      if (path === detail.outLogPath) {
        return {
          lines: cursor ? [] : ['out-only'],
          cursor: null,
          hasMore: false,
          rotated: false,
          truncated: false,
        };
      }
      return cursor
        ? {
            lines: ['err-older'],
            cursor: null,
            hasMore: false,
            rotated: false,
            truncated: false,
          }
        : {
            lines: ['err-newer'],
            cursor: { inode: '1:2', offset: 10 },
            hasMore: true,
            rotated: false,
            truncated: false,
          };
    });
    const manager = createLogManager({
      processManager: { detail: vi.fn().mockResolvedValue(detail) },
      pm2Daemon: { readLogLines: readPreviousLines, onLog: vi.fn(), onDaemonStatus: vi.fn() },
    } as never);

    const newest = await manager.page(1, 'combined', null, 10);
    const older = await manager.page(1, 'combined', newest.cursor, 10);

    expect(newest.entries.map(entry => entry.text)).toContain('out-only');
    expect(older.entries.map(entry => entry.text)).toEqual(['err-older']);
    expect(
      readPreviousLines.mock.calls.filter(([path]) => path === detail.outLogPath)
    ).toHaveLength(1);
    expect(older.hasMore).toBe(false);
  });

  it('rejects malformed opaque cursors', async () => {
    const manager = createLogManager({
      processManager: { detail: vi.fn().mockResolvedValue(detail) },
      pm2Daemon: { readLogLines: vi.fn(), onLog: vi.fn(), onDaemonStatus: vi.fn() },
    } as never);
    const malformed = Buffer.from(JSON.stringify({ out: { inode: 4, offset: -1 } })).toString(
      'base64url'
    );

    await expect(manager.page(1, 'combined', malformed, 10)).rejects.toThrow('Invalid log cursor');
  });
});
