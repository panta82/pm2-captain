// Runs the desktop app from source. Its backend is the same code as `npm run
// dev`, in its own process on its own port, with Vite's middleware, so
// frontend edits hot-reload. Main, preload and backend edits are rebuilt and
// restart Electron; dev_backend.mjs compiles the backend into dist/ as `npm
// run build` does. Shows simulated daemons (PM2_CAPTAIN_DESKTOP_FAKE, default
// "basic") unless --real is given, which uses the real daemon registry shared
// with the npm command. The profile is build/desktop/dev-profile unless
// PM2_CAPTAIN_DESKTOP_PROFILE_DIR is set.
//
// Usage: npm run desktop:dev [-- --real] [-- <electron arguments>]
import electronBinary from 'electron';
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import libPath from 'node:path';
import { fileURLToPath } from 'node:url';

import { watchBackend } from './dev_backend.mjs';
import { createRestartableProcess } from './restartable_process.mjs';

/** How long Electron may take to quit, on a restart or Ctrl+C, before it is killed. */
const ELECTRON_STOP_LIMIT_MS = 10_000;
const rootDir = libPath.resolve(libPath.dirname(fileURLToPath(import.meta.url)), '../..');
const devDir = libPath.join(rootDir, 'build/desktop/dev');
const args = process.argv.slice(2);
const isReal = args.includes('--real');
const electronArgs = args.filter(argument => argument !== '--real');
const { version } = JSON.parse(readFileSync(libPath.join(rootDir, 'package.json'), 'utf8'));

mkdirSync(devDir, { recursive: true });
writeFileSync(
  libPath.join(devDir, 'package.json'),
  `${JSON.stringify({ name: 'pm2-captain-desktop', productName: 'PM2 Captain', version, main: 'main.js' }, null, 2)}\n`
);

// --real means real daemons, even when the shell exports a fake scenario.
const { PM2_CAPTAIN_DESKTOP_FAKE: fakeScenario, ...inheritedEnvironment } = process.env;

let isStopping = false;
// Both builds report on their first run; Electron starts once both are done.
const pendingFirstBuilds = new Set(['shell', 'backend']);

// The electron package's Node entry is the path of the Electron binary itself.
// Spawned directly, not through the node_modules/.bin wrapper, a SIGKILL
// reaches the app instead of leaving it running without the wrapper.
const electron = createRestartableProcess({
  start: () =>
    spawn(electronBinary, [devDir, ...electronArgs], {
      stdio: 'inherit',
      env: {
        ...inheritedEnvironment,
        PM2_CAPTAIN_DESKTOP_DEV_BACKEND: libPath.join(
          rootDir,
          'dist/desktop/backend/desktop_backend.js'
        ),
        PM2_CAPTAIN_DESKTOP_PROFILE_DIR:
          process.env.PM2_CAPTAIN_DESKTOP_PROFILE_DIR ||
          libPath.join(rootDir, 'build/desktop/dev-profile'),
        ...(isReal ? {} : { PM2_CAPTAIN_DESKTOP_FAKE: fakeScenario || 'basic' }),
      },
    }),
  stopLimitMs: ELECTRON_STOP_LIMIT_MS,
  // Closing the window ends the dev session.
  onExit: code => process.exit(code ?? 0),
});

/** Restarts Electron after a successful rebuild, one restart at a time. */
const restartAfterBuild = name => {
  pendingFirstBuilds.delete(name);
  if (!pendingFirstBuilds.size && !isStopping) {
    void electron.restart();
  }
};

// Main and the preloads, bundled.
const shellBuilder = await context({
  absWorkingDir: rootDir,
  entryPoints: {
    main: 'src/desktop/main/main.ts',
    preload: 'src/desktop/preload/preload.ts',
    find_bar_preload: 'src/desktop/preload/find_bar_preload.ts',
  },
  outdir: devDir,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: 'inline',
  logLevel: 'info',
  plugins: [
    {
      name: 'restart-electron',
      setup(build) {
        build.onEnd(result => {
          if (!result.errors.length) {
            restartAfterBuild('shell');
          }
        });
      },
    },
  ],
});
await shellBuilder.watch();
// The backend and its desktop entry, file by file into dist/ as `npm run build`
// compiles the backend, so it finds its frontend sources and Vite config.
const backend = await watchBackend({
  rootDir,
  directories: ['src/backend', 'src/shared', 'src/desktop/backend', 'src/desktop/shared'],
  outdir: 'dist',
  onBuilt: () => restartAfterBuild('backend'),
});

/**
 * Stops the builds and Electron, including a restart under way, within the
 * stop limit. Repeated signals wait for the same stop.
 */
const stop = async () => {
  isStopping = true;
  await Promise.all([shellBuilder.dispose(), backend.dispose(), electron.stop()]);
  process.exit(0);
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!isStopping) {
      void stop();
    }
  });
}
