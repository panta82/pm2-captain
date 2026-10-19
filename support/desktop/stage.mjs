// Stages the desktop app payload in build/desktop/app from an existing `npm run
// build`: the shared dist output, the bundled Electron main and preload, the
// desktop backend entry, and production dependencies installed from the root
// lockfile. electron-builder packages that directory.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import libPath from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileUnbundled, listSources } from '../build-backend.mjs';

const rootDir = libPath.resolve(libPath.dirname(fileURLToPath(import.meta.url)), '../..');
const stageDir = libPath.join(rootDir, 'build/desktop/app');
const rootPackage = JSON.parse(readFileSync(libPath.join(rootDir, 'package.json'), 'utf8'));

/** The Linux package and executable name; never the npm command's `pm2-captain`. */
export const DESKTOP_PACKAGE_NAME = 'pm2-captain-desktop';

for (const part of ['backend', 'shared', 'frontend']) {
  if (!existsSync(libPath.join(rootDir, 'dist', part))) {
    console.error(`dist/${part} is missing. Run "npm run build" first.`);
    process.exit(1);
  }
}

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// The same build that the npm package ships.
for (const part of ['backend', 'shared', 'frontend']) {
  cpSync(libPath.join(rootDir, 'dist', part), libPath.join(stageDir, 'dist', part), {
    recursive: true,
    filter: source => !source.endsWith('.map'),
  });
}

// Main and the preloads are bundled, electron-updater included, so it is never
// an npm dependency. A preload runs sandboxed and must be a single file.
await build({
  absWorkingDir: rootDir,
  entryPoints: {
    main: 'src/desktop/main/main.ts',
    preload: 'src/desktop/preload/preload.ts',
    find_bar_preload: 'src/desktop/preload/find_bar_preload.ts',
  },
  outdir: libPath.join(stageDir, 'dist/desktop'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'warning',
});

// The backend entry stays unbundled like the backend it loads, which resolves
// its services by file path.
await compileUnbundled(
  listSources(['src/desktop/backend', 'src/desktop/shared']),
  libPath.join(stageDir, 'dist')
);
for (const file of readdirSync(libPath.join(stageDir, 'dist/desktop'), { recursive: true })) {
  if (String(file).endsWith('.map')) {
    rmSync(libPath.join(stageDir, 'dist/desktop', String(file)));
  }
}

// Production dependencies, exactly as locked for the npm package.
cpSync(libPath.join(rootDir, 'package.json'), libPath.join(stageDir, 'package.json'));
cpSync(libPath.join(rootDir, 'package-lock.json'), libPath.join(stageDir, 'package-lock.json'));
execFileSync(
  'npm',
  ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
  { cwd: stageDir, stdio: 'inherit', env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } }
);
rmSync(libPath.join(stageDir, 'package-lock.json'));

// A native addon would have to match Electron's ABI and every target platform.
const nativeAddons = readdirSync(libPath.join(stageDir, 'node_modules'), {
  recursive: true,
}).filter(file => String(file).endsWith('.node') || String(file).endsWith('binding.gyp'));
if (nativeAddons.length) {
  console.error(
    `Native addons are not supported in the desktop payload: ${nativeAddons.join(', ')}`
  );
  process.exit(1);
}

// The desktop app's manifest. The version is the root package's.
writeFileSync(
  libPath.join(stageDir, 'package.json'),
  `${JSON.stringify(
    {
      name: DESKTOP_PACKAGE_NAME,
      productName: 'PM2 Captain',
      version: rootPackage.version,
      description: 'Desktop control room for PM2 processes and logs',
      author: rootPackage.author,
      homepage: rootPackage.homepage,
      license: rootPackage.license,
      main: 'dist/desktop/main.js',
      // The Wayland app ID, matching the installed desktop entry.
      desktopName: `${DESKTOP_PACKAGE_NAME}.desktop`,
      dependencies: rootPackage.dependencies,
    },
    null,
    2
  )}\n`
);

console.log(
  `Staged PM2 Captain ${rootPackage.version} desktop payload in ${libPath.relative(rootDir, stageDir)}`
);
