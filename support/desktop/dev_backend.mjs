// Keeps the backend compiled for `npm run desktop:dev`: file by file into
// dist/, as `npm run build` compiles it. An esbuild context has fixed entry
// points, so instead of esbuild's own watcher, this watches the source
// directories itself. On a change it lists the sources again; when files were
// added or removed it replaces the context and deletes the removed files'
// output, and then it rebuilds. Rebuilds run one at a time.
import { context } from 'esbuild';
import { rmSync, watch } from 'node:fs';
import libPath from 'node:path';

import { listSources, unbundledOptions } from '../build-backend.mjs';

/** Editors and git touch several files at once; one rebuild covers the burst. */
const REBUILD_DELAY_MS = 100;

/**
 * Starts compiling `directories` (relative to `rootDir`, under its `src/`) into
 * `outdir`. `onBuilt` runs after every build without errors; esbuild prints the
 * errors of the others. Resolves after the first build; `dispose()` stops
 * watching and waits for a build that is under way.
 */
export async function watchBackend({ rootDir, directories, outdir, onBuilt }) {
  const outputRoot = libPath.resolve(rootDir, outdir);
  let sources = listSources(directories, rootDir);
  let builder = null;
  let isDisposed = false;
  // A source file changed since the last build; additions and removals of
  // other files only matter when they change the list.
  let hasSourceChange = true;
  let rebuildTimer = null;
  let builds = Promise.resolve();

  /** The compiled files of a source, only ever inside the output directory. */
  const outputsOf = source => {
    const output = libPath.resolve(
      outputRoot,
      libPath.relative('src', source).replace(/\.ts$/, '.js')
    );
    if (!output.startsWith(`${outputRoot}${libPath.sep}`)) {
      return [];
    }
    return [output, `${output}.map`];
  };

  const build = async () => {
    if (isDisposed) {
      return;
    }
    let next;
    try {
      next = listSources(directories, rootDir);
    } catch (error) {
      // A directory can be missing for a moment, for example during a git
      // checkout; its next event builds again.
      console.error(`Unable to list the backend sources: ${error.message}`);
      return;
    }
    const isListChanged = next.join('\n') !== sources.join('\n');
    if (!isListChanged && !hasSourceChange && builder) {
      return;
    }
    hasSourceChange = false;
    if (isListChanged) {
      const removed = sources.filter(source => !next.includes(source));
      sources = next;
      await builder?.dispose();
      builder = null;
      for (const output of removed.flatMap(outputsOf)) {
        rmSync(output, { force: true });
      }
    }
    builder ??= await context(unbundledOptions(sources, outdir, rootDir));
    if (isDisposed) {
      return;
    }
    try {
      await builder.rebuild();
    } catch {
      // esbuild has printed the errors; the next change builds again.
      return;
    }
    if (!isDisposed) {
      onBuilt();
    }
  };

  const queueBuild = () => {
    builds = builds.then(build).catch(error => {
      console.error(`Unable to compile the backend: ${error.message}`);
    });
  };

  const watchers = directories.map(directory =>
    watch(libPath.join(rootDir, directory), { recursive: true }, (event, fileName) => {
      // Without a file name (fs.watch does not always have one), any source
      // may have changed.
      if (!fileName || fileName.endsWith('.ts')) {
        hasSourceChange = true;
      }
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(queueBuild, REBUILD_DELAY_MS);
    }).on('error', error => console.error(`Unable to watch ${directory}: ${error.message}`))
  );
  queueBuild();
  await builds;

  return {
    dispose: async () => {
      isDisposed = true;
      clearTimeout(rebuildTimer);
      for (const watcher of watchers) {
        watcher.close();
      }
      await builds;
      await builder?.dispose();
      builder = null;
    },
  };
}
