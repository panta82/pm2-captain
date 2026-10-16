import { existsSync, promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error A plain ES module script without types.
import { watchBackend } from '../../../support/desktop/dev_backend.mjs';

interface IBackendWatch {
  dispose: () => Promise<void>;
}

let root: string;
let watcher: IBackendWatch | null;
let builds: number;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Builds follow file events after a short delay. */
const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out');
    }
    await sleep(50);
  }
};

const write = async (path: string, content: string) => {
  await fs.mkdir(libPath.dirname(libPath.join(root, path)), { recursive: true });
  await fs.writeFile(libPath.join(root, path), content);
};
const output = (path: string) => libPath.join(root, 'dist', path);
const start = async (directories = ['src/backend']) => {
  watcher = await watchBackend({
    rootDir: root,
    directories,
    outdir: 'dist',
    onBuilt: () => {
      builds++;
    },
  });
};

beforeEach(async () => {
  root = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-dev-backend-'));
  watcher = null;
  builds = 0;
  await write('src/backend/a.ts', 'export const a: number = 1;\n');
});

afterEach(async () => {
  await watcher?.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

describe('watchBackend', () => {
  it('compiles files that are added after it started', async () => {
    await start();
    await waitFor(() => existsSync(output('backend/a.js')) && builds > 0);

    const buildsBefore = builds;
    await write('src/backend/nested/b.ts', 'export const b: string = "b";\n');

    await waitFor(() => existsSync(output('backend/nested/b.js')));
    await waitFor(() => builds > buildsBefore);
  });

  it('removes the output of deleted files and keeps rebuilding the rest', async () => {
    await write('src/backend/b.ts', 'export const b = 1;\n');
    await start();
    await waitFor(() => existsSync(output('backend/a.js')) && existsSync(output('backend/b.js')));

    await fs.rm(libPath.join(root, 'src/backend/a.ts'));
    await waitFor(() => !existsSync(output('backend/a.js')));
    expect(existsSync(output('backend/a.js.map'))).toBe(false);

    await write('src/backend/b.ts', 'export const b = 2;\n');
    await waitFor(async () =>
      (await fs.readFile(output('backend/b.js'), 'utf8')).includes('b = 2')
    );
  });

  it('reports only builds without errors', async () => {
    await start();
    await waitFor(() => builds > 0);
    const buildsBefore = builds;

    await write('src/backend/a.ts', 'export const a = ;\n');
    await sleep(500);
    expect(builds).toBe(buildsBefore);

    await write('src/backend/a.ts', 'export const a = 3;\n');
    await waitFor(() => builds > buildsBefore);
    expect(await fs.readFile(output('backend/a.js'), 'utf8')).toContain('a = 3');
  });

  it('builds nothing after it was disposed, also during a replacement', async () => {
    await start();
    await waitFor(() => builds > 0);

    // The build for this addition is still pending or running when dispose arrives.
    await write('src/backend/c.ts', 'export const c = 1;\n');
    await sleep(120);
    await watcher?.dispose();
    const buildsAfterDispose = builds;

    await write('src/backend/d.ts', 'export const d = 1;\n');
    await write('src/backend/a.ts', 'export const a = 2;\n');
    await sleep(1_500);

    expect(existsSync(output('backend/d.js'))).toBe(false);
    expect(builds).toBe(buildsAfterDispose);
    expect(await fs.readFile(output('backend/a.js'), 'utf8')).not.toContain('a = 2');
  });

  it('never deletes a file outside its output directory', async () => {
    await write('lib/x.ts', 'export const x = 1;\n');
    // What a removed source outside src/ would map to without the check.
    await write('lib/x.js', 'kept\n');
    await start(['src/backend', 'lib']);
    await waitFor(() => builds > 0);

    await fs.rm(libPath.join(root, 'lib/x.ts'));
    await sleep(500);

    expect(await fs.readFile(libPath.join(root, 'lib/x.js'), 'utf8')).toBe('kept\n');
  });
});
