import { mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogFileReader } from './log_file_reader';

describe('logFileReader', () => {
  let directory: string;
  let path: string;
  const warn = vi.fn();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pm2-captain-reader-'));
    path = join(directory, 'process.log');
    warn.mockClear();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const reader = () => createLogFileReader({ log: { warn } } as never);

  it('pages backward without duplicating a trailing newline', async () => {
    await writeFile(path, 'one\ntwo\nthree\nfour\n', 'utf8');

    const newest = await reader().readPreviousLines(path, null, 2);
    expect(newest.lines).toEqual(['three', 'four']);
    expect(newest.hasMore).toBe(true);

    const older = await reader().readPreviousLines(path, newest.cursor, 2);
    expect(older.lines).toEqual(['one', 'two']);
    expect(older.hasMore).toBe(false);
  });

  it('keeps a missing final newline and UTF-8 characters intact', async () => {
    await writeFile(path, 'αρχή\ncaptain 🚢\n最後', 'utf8');

    const newest = await reader().readPreviousLines(path, null, 2);
    expect(newest.lines).toEqual(['captain 🚢', '最後']);
    const older = await reader().readPreviousLines(path, newest.cursor, 2);
    expect(older.lines).toEqual(['αρχή']);
  });

  it('resets a stale cursor after truncation', async () => {
    await writeFile(path, 'one\ntwo\nthree\n', 'utf8');
    const first = await reader().readPreviousLines(path, null, 1);
    await truncate(path, 4);

    const reset = await reader().readPreviousLines(path, first.cursor, 10);
    expect(reset.rotated).toBe(true);
    expect(reset.lines).toEqual(['one']);
  });

  it('detects replacement by inode and reads the replacement', async () => {
    await writeFile(path, 'old-a\nold-b\n', 'utf8');
    const first = await reader().readPreviousLines(path, null, 1);
    await rename(path, join(directory, 'process.log.1'));
    await writeFile(path, 'new-a\nnew-b\n', 'utf8');

    const reset = await reader().readPreviousLines(path, first.cursor, 10);
    expect(reset.rotated).toBe(true);
    expect(reset.lines).toEqual(['new-a', 'new-b']);
  });

  it('treats absent, empty, and null-device logs as empty', async () => {
    await writeFile(path, '', 'utf8');

    await expect(reader().readPreviousLines(path, null, 10)).resolves.toMatchObject({
      lines: [],
      hasMore: false,
    });
    await expect(
      reader().readPreviousLines(join(directory, 'missing.log'), null, 10)
    ).resolves.toMatchObject({ lines: [], hasMore: false });
    await expect(reader().readPreviousLines('/dev/null', null, 10)).resolves.toMatchObject({
      lines: [],
      hasMore: false,
    });
  });
});
