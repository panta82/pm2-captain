import { IFileCursor, IReverseLinePage } from '../lib/log_file_reader';
import { IFakeLogProfile } from './fake_scenario';

/** Lines kept per simulated file, so fast generation cannot grow without bound. */
const MAX_FILE_LINES = 100_000;

const OUT_MESSAGES = [
  'GET /api/users/{n} 200 {ms}ms',
  'POST /api/orders 201 {ms}ms',
  'GET /api/search?q=item-{n} 200 {ms}ms',
  'GET /health 200 1ms',
  'Job {n} completed in {ms}ms',
  'Cache refreshed ({n} keys)',
  'Queue depth is {n}',
  'Sent a notification to user {n}',
];

const ERROR_MESSAGES = [
  'Request failed: upstream timed out after {ms}ms',
  'Unhandled rejection: connection reset by peer',
  'Job {n} failed and will be retried',
  'Slow query took {ms}ms',
  'Rate limit exceeded for client {n}',
];

const STACK_FRAMES = [
  '    at handleRequest (/srv/app/dist/server.js:214:17)',
  '    at Router.dispatch (/srv/app/dist/router.js:88:9)',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
];

/** A seeded generator (mulberry32), so a scenario produces the same logs every time. */
export function createRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** One generated log entry. A stack trace spans several lines. */
export function generateLogEntry(
  profile: IFakeLogProfile,
  channel: 'out' | 'err',
  random: () => number,
  time: number
): string {
  const messages = channel === 'err' ? ERROR_MESSAGES : OUT_MESSAGES;
  const message = messages[Math.floor(random() * messages.length)]
    .replace('{n}', String(Math.floor(random() * 10_000)))
    .replace('{ms}', String(Math.floor(random() * 900) + 1));
  const timestamp = new Date(time).toISOString();
  const level = channel === 'err' ? 'ERROR' : 'INFO';

  if (profile === 'plain') {
    return message;
  }
  if (profile === 'json') {
    return JSON.stringify({ level: level.toLowerCase(), time: timestamp, message });
  }
  const line = `${timestamp} ${level} ${message}`;
  if (profile === 'stack' && channel === 'err') {
    return [line, ...STACK_FRAMES].join('\n');
  }
  if (profile === 'long' && random() < 0.3) {
    const payload = 'x'.repeat(2_000 + Math.floor(random() * 10_000));
    return `${line} payload=${payload}`;
  }
  return line;
}

/** A simulated log file. It pages the way `logFileReader` pages a real one, by lines. */
export class FakeLogFile {
  _lines: string[] = [];
  /** Lines dropped from the start. Cursor offsets count them, so they stay valid. */
  _droppedLines = 0;
  /** Changes when the file is rotated, like the inode of a real file. */
  _generation = 1;

  get lineCount() {
    return this._lines.length;
  }

  append = (text: string) => {
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') {
      lines.pop();
    }
    for (const line of lines) {
      this._lines.push(line);
    }
    const excess = this._lines.length - MAX_FILE_LINES;
    if (excess > 0) {
      // Drop in batches; shifting a long array on every line is slow.
      const dropCount = excess + MAX_FILE_LINES / 10;
      this._lines.splice(0, dropCount);
      this._droppedLines += dropCount;
    }
  };

  replace = (lines: string[]) => {
    this._lines = [];
    this._droppedLines = 0;
    for (const line of lines) {
      this.append(line);
    }
  };

  rotate = () => {
    this._generation++;
    this._lines = [];
    this._droppedLines = 0;
  };

  readPreviousLines = (cursor: IFileCursor | null, limit: number): IReverseLinePage => {
    const inode = `fake:${this._generation}`;
    const size = this._droppedLines + this._lines.length;
    const rotated = Boolean(cursor && (cursor.inode !== inode || cursor.offset > size));
    const boundary = rotated || !cursor ? size : cursor.offset;
    const start = Math.max(this._droppedLines, boundary - limit);
    const hasMore = start > this._droppedLines;
    return {
      lines: this._lines.slice(
        start - this._droppedLines,
        Math.max(start, boundary) - this._droppedLines
      ),
      cursor: hasMore ? { inode, offset: start } : null,
      hasMore,
      rotated,
      truncated: false,
    };
  };
}
