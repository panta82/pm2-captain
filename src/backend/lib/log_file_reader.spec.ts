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

  const reader = () =>
    createLogFileReader({
      log: { warn },
      sshConnection: { isRemote: false },
    } as never);

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

  it('assembles partial SFTP reads while paging remote logs', async () => {
    const content = Buffer.from('one\ntwo\nthree\nfour\n');
    const close = vi.fn();
    const remoteReader = createLogFileReader({
      log: { warn },
      sshConnection: {
        isRemote: true,
        openFile: vi.fn(async () => ({
          stat: async () => ({ identity: 'remote-file', size: content.length }),
          read: async (buffer: Buffer, offset: number, length: number, position: number) => {
            const bytesRead = Math.min(7, length, Math.max(0, content.length - position));
            content.copy(buffer, offset, position, position + bytesRead);
            return { bytesRead };
          },
          close,
        })),
      },
    } as never);

    const newest = await remoteReader.readPreviousLines('/remote/process.log', null, 2);
    const older = await remoteReader.readPreviousLines('/remote/process.log', newest.cursor, 2);

    expect(newest.lines).toEqual(['three', 'four']);
    expect(older.lines).toEqual(['one', 'two']);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('keeps a successful page when closing the remote file fails', async () => {
    const closeError = new Error('SFTP close failed');
    const content = Buffer.from('captain log');
    const remoteReader = createLogFileReader({
      log: { warn },
      sshConnection: {
        isRemote: true,
        openFile: vi.fn(async () => ({
          stat: async () => ({ identity: 'remote-file', size: content.length }),
          read: async (buffer: Buffer, offset: number, length: number, position: number) => {
            const bytesRead = Math.min(length, Math.max(0, content.length - position));
            content.copy(buffer, offset, position, position + bytesRead);
            return { bytesRead };
          },
          close: vi.fn(async () => {
            throw closeError;
          }),
        })),
      },
    } as never);

    await expect(
      remoteReader.readPreviousLines('/remote/process.log', null, 10)
    ).resolves.toMatchObject({ lines: ['captain log'] });
    expect(warn).toHaveBeenCalledWith(
      { error: closeError, path: '/remote/process.log' },
      'Unable to close PM2 log file'
    );
  });

  it('logs remote read failures before returning an empty page', async () => {
    const connectionError = Object.assign(new Error('Connection refused'), {
      code: 'SSH_CONNECTION_FAILED',
    });
    const remoteReader = createLogFileReader({
      log: { warn },
      sshConnection: {
        isRemote: true,
        openFile: vi.fn(async () => {
          throw connectionError;
        }),
      },
    } as never);

    await expect(remoteReader.readPreviousLines('/remote/process.log', null, 10)).resolves.toEqual({
      lines: [],
      cursor: null,
      hasMore: false,
      rotated: false,
      truncated: false,
    });
    expect(warn).toHaveBeenCalledWith(
      { error: connectionError, path: '/remote/process.log' },
      'Unable to read PM2 log file'
    );
  });
});
