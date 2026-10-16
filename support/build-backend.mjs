// Compiles the backend and shared sources file by file into dist/, keeping
// packages external. Plain Node, so it needs neither ripgrep nor a newer Bash.
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import libPath from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = libPath.resolve(libPath.dirname(fileURLToPath(import.meta.url)), '..');

/** TypeScript sources under the given directories, without declaration files. */
export function listSources(directories, root = rootDir) {
  return directories
    .flatMap(directory =>
      readdirSync(libPath.join(root, directory), { recursive: true, withFileTypes: true })
        .filter(
          entry => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
        )
        .map(entry =>
          libPath.relative(root, libPath.join(entry.parentPath ?? entry.path, entry.name))
        )
    )
    .sort();
}

/** Per-file CommonJS for Node 22, source maps, packages external. */
export function unbundledOptions(entryPoints, outdir, root = rootDir) {
  return {
    absWorkingDir: root,
    entryPoints,
    outdir,
    outbase: 'src',
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    packages: 'external',
    sourcemap: true,
    logLevel: 'warning',
  };
}

export function compileUnbundled(entryPoints, outdir) {
  return build(unbundledOptions(entryPoints, outdir));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await compileUnbundled(listSources(['src/backend', 'src/shared']), 'dist');
}
