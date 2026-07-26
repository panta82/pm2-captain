import { randomUUID } from 'node:crypto';

import { observable } from '@trpc/server/observable';

import {
  ILogChannel,
  ILogEntry,
  ILogPage,
  ILogStreamEvent,
  ILogView,
} from '../../shared/contracts';
import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IFileCursor } from '../lib/log_file_reader';
import { IPM2LogEvent } from '../lib/pm2_client';

interface ILogCursor {
  out?: IFileCursor | null;
  err?: IFileCursor | null;
  shared?: IFileCursor | null;
  outDone?: boolean;
  errDone?: boolean;
}

function encodeCursor(cursor: ILogCursor): string | null {
  if (
    !cursor.out &&
    !cursor.err &&
    !cursor.shared &&
    !cursor.outDone &&
    !cursor.errDone
  ) {
    return null;
  }
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(cursor?: string | null): ILogCursor {
  if (!cursor) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid log cursor');
    }
    for (const key of ['out', 'err', 'shared'] as const) {
      const value = parsed[key];
      if (
        value !== undefined &&
        value !== null &&
        (typeof value !== 'object' ||
          typeof value.inode !== 'string' ||
          !Number.isSafeInteger(value.offset) ||
          value.offset < 0)
      ) {
        throw new Error('Invalid log cursor');
      }
    }
    for (const key of ['outDone', 'errDone'] as const) {
      if (parsed[key] !== undefined && typeof parsed[key] !== 'boolean') {
        throw new Error('Invalid log cursor');
      }
    }
    return parsed;
  } catch {
    throw new Error('Invalid log cursor');
  }
}

function parseLine(
  line: string,
  pmId: number,
  processName: string,
  channel: ILogChannel,
  sequence: number
): ILogEntry {
  let text = line;
  let timestamp: number | null = null;

  if (line.startsWith('{')) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.message === 'string') {
        text = parsed.message;
      }
      const rawTimestamp = parsed.timestamp || parsed.time || parsed.at;
      const parsedTimestamp = rawTimestamp ? new Date(rawTimestamp).getTime() : NaN;
      timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
    } catch {
      // Raw application output can legitimately start with "{".
    }
  }
  if (timestamp === null) {
    const match = line.match(
      /^(?:\[[^\]]+\]\s*)?(\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?)/
    );
    if (match) {
      const parsedTimestamp = new Date(match[1]).getTime();
      timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
    }
  }

  return {
    id: `${channel}:${sequence}:${randomUUID()}`,
    pmId,
    processName,
    channel,
    text,
    timestamp,
    sequence,
  };
}

export function createLogManager({ processManager, logFileReader, pm2Client }: IContainer) {
  let liveSequence = 0;

  return new (class LogManager {
    page = async (
      pmId: number,
      view: ILogView,
      cursorValue?: string | null,
      requestedLimit = 500
    ): Promise<ILogPage> => {
      const detail = await processManager.detail(pmId);
      const limit = Math.min(1_000, Math.max(1, requestedLimit));
      const cursor = decodeCursor(cursorValue);
      const sharedFile =
        Boolean(detail.outLogPath) && detail.outLogPath === detail.errLogPath;

      if (sharedFile) {
        const page = await logFileReader.readPreviousLines(
          detail.outLogPath,
          cursor.shared || null,
          limit
        );
        return {
          entries: page.lines.map((line, index) =>
            parseLine(line, pmId, detail.name, 'shared', index)
          ),
          cursor: encodeCursor({ shared: page.cursor }),
          hasMore: page.hasMore,
          approximateOrder: false,
          sharedFile: true,
          rotated: page.rotated,
        };
      }

      const readChannel = async (channel: 'out' | 'err', channelLimit: number) => {
        if (cursor[`${channel}Done`]) {
          return {
            lines: [],
            cursor: null,
            hasMore: false,
            rotated: false,
            truncated: false,
            entries: [],
          };
        }
        const path = channel === 'out' ? detail.outLogPath : detail.errLogPath;
        const page = await logFileReader.readPreviousLines(path, cursor[channel] || null, channelLimit);
        return {
          ...page,
          entries: page.lines.map((line, index) =>
            parseLine(line, pmId, detail.name, channel, index)
          ),
        };
      };

      if (view === 'out' || view === 'err') {
        const page = await readChannel(view, limit);
        return {
          entries: page.entries,
          cursor: encodeCursor({ [view]: page.cursor }),
          hasMore: page.hasMore,
          approximateOrder: false,
          sharedFile: false,
          rotated: page.rotated,
        };
      }

      const perChannelLimit = Math.ceil(limit / 2);
      const [out, err] = await Promise.all([
        readChannel('out', perChannelLimit),
        readChannel('err', perChannelLimit),
      ]);
      const entries = [...out.entries, ...err.entries];
      const approximateOrder = entries.some(entry => entry.timestamp === null);
      entries.sort((left, right) => {
        if (left.timestamp !== null && right.timestamp !== null) {
          return left.timestamp - right.timestamp;
        }
        if (left.channel !== right.channel) {
          return left.channel.localeCompare(right.channel);
        }
        return left.sequence - right.sequence;
      });

      return {
        entries,
        cursor: encodeCursor({
          out: out.cursor,
          err: err.cursor,
          outDone: !out.hasMore,
          errDone: !err.hasMore,
        }),
        hasMore: out.hasMore || err.hasMore,
        approximateOrder,
        sharedFile: false,
        rotated: out.rotated || err.rotated,
      };
    };

    stream = (pmId: number, view: ILogView) =>
      observable<ILogStreamEvent>(emit => {
        const removeLog = pm2Client.onLog((event: IPM2LogEvent) => {
          if (event.packet.process.pm_id !== pmId) {
            return;
          }
          if (view !== 'combined' && view !== event.type) {
            return;
          }
          for (const line of event.packet.data.split(/\r?\n/)) {
            if (!line.length) {
              continue;
            }
            liveSequence++;
            emit.next({
              type: 'log',
              entry: {
                id: `live:${liveSequence}:${randomUUID()}`,
                pmId,
                processName: event.packet.process.name,
                channel: event.type,
                text: line,
                timestamp:
                  typeof event.packet.at === 'number' ? event.packet.at : Date.now(),
                sequence: liveSequence,
              },
            });
          }
        });
        const removeStatus = pm2Client.onDaemonStatus(connected => {
          emit.next({
            type: 'daemon-status',
            connected,
            message: connected ? 'Connected to PM2' : 'PM2 event bus disconnected',
          });
        });
        return () => {
          removeLog();
          removeStatus();
        };
      });
  })();
}

export default define({
  createLogManager,
});
