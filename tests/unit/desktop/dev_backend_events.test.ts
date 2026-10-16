import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error A plain ES module script without types.
import { watchBackend } from '../../../support/desktop/dev_backend.mjs';

type IWatchListener = (event: string, fileName: string | null) => void;

// The watch events come from the test, so each case controls exactly what
// fs.watch reports.
const listeners: IWatchListener[] = [];
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: (_path: string, _options: object, listener: IWatchListener) => {
      listeners.push(listener);
      const watcher = { on: () => watcher, close: () => undefined };
      return watcher;
    },
  };
});

let root: string;
let watcher: { dispose: () => Promise<void> } | null;
let builds: number;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const compiled = () => fs.readFile(libPath.join(root, 'dist/backend/a.js'), 'utf8');

beforeEach(async () => {
  root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-dev-backend-events-'));
  await fs.mkdir(libPath.join(root, 'src/backend'), { recursive: true });
  await fs.writeFile(libPath.join(root, 'src/backend/a.ts'), 'export const a = 1;\n');
  listeners.length = 0;
  builds = 0;
  watcher = await watchBackend({
    rootDir: root,
    directories: ['src/backend'],
    outdir: 'dist',
    onBuilt: () => {
      builds++;
    },
  });
});

afterEach(async () => {
  await watcher?.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

describe('watchBackend events', () => {
  it('rebuilds when fs.watch reports a change without a file name', async () => {
    expect(builds).toBe(1);
    await fs.writeFile(libPath.join(root, 'src/backend/a.ts'), 'export const a = 2;\n');

    listeners[0]('change', null);
    await sleep(500);

    expect(builds).toBe(2);
    expect(await compiled()).toContain('a = 2');
  });

  it('does not rebuild for other files when the source list is unchanged', async () => {
    await fs.writeFile(libPath.join(root, 'src/backend/a.ts'), 'export const a = 3;\n');

    listeners[0]('rename', 'notes.txt');
    await sleep(500);

    expect(builds).toBe(1);
    expect(await compiled()).toContain('a = 1');
  });
});
