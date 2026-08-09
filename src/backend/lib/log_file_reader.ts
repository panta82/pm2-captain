import { promises as fs } from 'node:fs';

import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IRandomAccessFile } from './ssh_connection';

export interface IFileCursor {
  inode: string;
  offset: number;
}

export interface IReverseLinePage {
  lines: string[];
  cursor: IFileCursor | null;
  hasMore: boolean;
  rotated: boolean;
  truncated: boolean;
}

const READ_CHUNK_SIZE = 64 * 1024;
const REMOTE_READ_CHUNK_SIZE = 512 * 1024;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

export function createLogFileReader({ log, sshConnection }: IContainer) {
  const openFile = async (path: string): Promise<IRandomAccessFile> => {
    if (sshConnection.isRemote) {
      return sshConnection.openFile(path);
    }
    const handle = await fs.open(path, 'r');
    return {
      stat: async () => {
        const stat = await handle.stat();
        return { identity: `${stat.dev}:${stat.ino}`, size: stat.size };
      },
      read: async (buffer, offset, length, position) => {
        const { bytesRead } = await handle.read(buffer, offset, length, position);
        return { bytesRead };
      },
      close: async () => handle.close(),
    };
  };

  const readAt = async (
    handle: IRandomAccessFile,
    buffer: Buffer,
    length: number,
    position: number
  ) => {
    let total = 0;
    while (total < length) {
      const { bytesRead } = await handle.read(buffer, total, length - total, position + total);
      if (!bytesRead) {
        break;
      }
      total += bytesRead;
    }
    return total;
  };

  return new (class LogFileReader {
    readPreviousLines = async (
      path: string | null,
      cursor: IFileCursor | null,
      limit: number
    ): Promise<IReverseLinePage> => {
      if (!path || path === '/dev/null' || path === 'NULL') {
        return { lines: [], cursor: null, hasMore: false, rotated: false, truncated: false };
      }

      let handle;
      try {
        handle = await openFile(path);
        const stat = await handle.stat();
        const inode = stat.identity;
        const rotated = Boolean(cursor && (cursor.inode !== inode || cursor.offset > stat.size));
        let boundary = rotated || !cursor ? stat.size : cursor.offset;

        if (boundary > 0) {
          const lastByte = Buffer.alloc(1);
          await readAt(handle, lastByte, 1, boundary - 1);
          if (lastByte[0] === 0x0a) {
            boundary--;
          }
        }

        let position = boundary;
        let start = boundary;
        let newlines = 0;
        let bytesInspected = 0;
        let truncated = false;

        while (position > 0 && newlines < limit) {
          const chunkSize = Math.min(
            sshConnection.isRemote ? REMOTE_READ_CHUNK_SIZE : READ_CHUNK_SIZE,
            position
          );
          const chunkStart = position - chunkSize;
          const chunk = Buffer.allocUnsafe(chunkSize);
          const bytesRead = await readAt(handle, chunk, chunkSize, chunkStart);
          const readableChunk = bytesRead === chunkSize ? chunk : chunk.subarray(0, bytesRead);

          for (let index = readableChunk.length - 1; index >= 0; index--) {
            if (readableChunk[index] === 0x0a) {
              newlines++;
              if (newlines === limit) {
                start = chunkStart + index + 1;
                break;
              }
            }
          }

          bytesInspected += chunkSize;
          if (newlines < limit) {
            start = chunkStart;
            position = chunkStart;
          }
          if (bytesInspected >= MAX_PAGE_BYTES && newlines < limit) {
            truncated = true;
            break;
          }
        }

        const length = Math.max(0, boundary - start);
        const data = Buffer.alloc(length);
        if (length) {
          await readAt(handle, data, length, start);
        }
        const text = data.toString('utf8');
        const lines = text.length ? text.split(/\r?\n/) : [];
        if (truncated && lines.length) {
          lines[0] = `… [line truncated] ${lines[0]}`;
        }

        return {
          lines,
          cursor: start > 0 ? { inode, offset: start } : null,
          hasMore: start > 0,
          rotated,
          truncated,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn({ error, path }, 'Unable to read PM2 log file');
        }
        return { lines: [], cursor: null, hasMore: false, rotated: false, truncated: false };
      } finally {
        try {
          await handle?.close();
        } catch (error) {
          log.warn({ error, path }, 'Unable to close PM2 log file');
        }
      }
    };
  })();
}

export default define({
  createLogFileReader,
});
