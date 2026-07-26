import { promises as fs } from 'node:fs';

import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';

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
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

export function createLogFileReader({ log }: IContainer) {
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
        handle = await fs.open(path, 'r');
        const stat = await handle.stat();
        const inode = `${stat.dev}:${stat.ino}`;
        const rotated = Boolean(cursor && (cursor.inode !== inode || cursor.offset > stat.size));
        let boundary = rotated || !cursor ? stat.size : cursor.offset;

        if (boundary > 0) {
          const lastByte = Buffer.alloc(1);
          await handle.read(lastByte, 0, 1, boundary - 1);
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
          const chunkSize = Math.min(READ_CHUNK_SIZE, position);
          const chunkStart = position - chunkSize;
          const chunk = Buffer.allocUnsafe(chunkSize);
          await handle.read(chunk, 0, chunkSize, chunkStart);

          for (let index = chunk.length - 1; index >= 0; index--) {
            if (chunk[index] === 0x0a) {
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
          await handle.read(data, 0, length, start);
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
        await handle?.close();
      }
    };
  })();
}

export default define({
  createLogFileReader,
});
