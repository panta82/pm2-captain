// Builds the Linux artifacts, one electron-builder run per target, and merges
// their update manifests into one latest-linux.yml.
//
// One run per target because electron-builder builds a platform's targets
// concurrently from one unpacked directory, and each DEB or RPM target writes
// its `package-type` (which electron-updater uses to pick its updater) into
// that shared directory. Built together, an AppImage or the other package
// could pick up the wrong type.
//
// The AppImage run also replaces the executable with support/desktop/appimage/
// launcher.sh, which drops the --no-sandbox that electron-builder's AppRun adds
// and decides again with the check Chromium's sandbox needs: it keeps the
// sandbox where user namespaces work, and otherwise adds --no-sandbox.
//
// Usage: node support/desktop/package-linux.mjs [--output <dir>] [AppImage deb rpm]
import { Arch, Platform, build } from 'electron-builder';
import yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import libPath from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = libPath.resolve(libPath.dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACT_EXTENSIONS = { AppImage: '.AppImage', deb: '.deb', rpm: '.rpm' };
export const LAUNCHER_PATH = libPath.join(rootDir, 'support/desktop/appimage/launcher.sh');

/**
 * Merges per-target manifests of one version. The AppImage entry stays the
 * legacy `path`, as electron-builder writes it; updaters pick their file from
 * `files` by extension.
 */
export function mergeLinuxManifests(manifests) {
  const versions = new Set(manifests.map(manifest => manifest.version));
  if (versions.size !== 1) {
    throw new Error(`The Linux manifests have different versions: ${[...versions].join(', ')}`);
  }
  const files = manifests.flatMap(manifest => manifest.files ?? []);
  const urls = files.map(file => file.url);
  if (new Set(urls).size !== urls.length) {
    throw new Error(`A Linux artifact is listed twice: ${urls.join(', ')}`);
  }
  const primary = files.find(file => file.url.endsWith('.AppImage')) ?? files[0];
  return {
    version: manifests[0].version,
    files,
    path: primary.url,
    sha512: primary.sha512,
    releaseDate: manifests[0].releaseDate,
  };
}

/**
 * The AppImage's afterPack hook. electron-builder flips fuses after this hook,
 * on the file named after the executable, so the hook flips them on the real
 * binary itself before moving it aside, and the run has `electronFuses` off.
 */
async function installAppImageLauncher(context, fuses) {
  const executable = libPath.join(context.appOutDir, context.packager.executableName);
  await context.packager.addElectronFuses(
    context,
    await context.packager.generateFuseConfig(fuses)
  );
  renameSync(executable, `${executable}.bin`);
  copyFileSync(LAUNCHER_PATH, executable);
  chmodSync(executable, 0o755);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const releaseDir = libPath.resolve(
    rootDir,
    outputIndex >= 0 ? args[outputIndex + 1] : 'build/desktop/release'
  );
  const targetArgs = args.filter(
    (_argument, index) => outputIndex < 0 || (index !== outputIndex && index !== outputIndex + 1)
  );
  const targets = targetArgs.length ? targetArgs : Object.keys(ARTIFACT_EXTENSIONS);
  const config = yaml.load(readFileSync(libPath.join(rootDir, 'electron-builder.yml'), 'utf8'));
  // Installed files must not be group-writable, whatever the local umask is.
  process.umask(0o022);
  mkdirSync(releaseDir, { recursive: true });
  const manifests = [];
  for (const target of targets) {
    if (!ARTIFACT_EXTENSIONS[target]) {
      throw new Error(`Unknown Linux target: ${target}`);
    }
    const outputDir = libPath.join(releaseDir, `.linux-${target}`);
    rmSync(outputDir, { recursive: true, force: true });
    const targetConfig = {
      ...config,
      directories: { ...config.directories, output: libPath.relative(rootDir, outputDir) },
      ...(target === 'AppImage'
        ? {
            electronFuses: null,
            afterPack: context => installAppImageLauncher(context, config.electronFuses),
          }
        : {}),
    };
    await build({
      projectDir: rootDir,
      targets: Platform.LINUX.createTarget(target, Arch.x64),
      config: targetConfig,
      publish: 'never',
    });
    for (const file of readdirSync(outputDir)) {
      if (file.endsWith(ARTIFACT_EXTENSIONS[target]) || file.endsWith('.blockmap')) {
        copyFileSync(libPath.join(outputDir, file), libPath.join(releaseDir, file));
      }
    }
    manifests.push(yaml.load(readFileSync(libPath.join(outputDir, 'latest-linux.yml'), 'utf8')));
    // One unpacked tree for smoke tests: the DEB's, which runs Electron directly.
    if (target === 'deb') {
      rmSync(libPath.join(releaseDir, 'linux-unpacked'), { recursive: true, force: true });
      execFileSync('cp', ['-a', libPath.join(outputDir, 'linux-unpacked'), releaseDir]);
    }
    rmSync(outputDir, { recursive: true, force: true });
  }
  writeFileSync(
    libPath.join(releaseDir, 'latest-linux.yml'),
    yaml.dump(mergeLinuxManifests(manifests), { lineWidth: -1 })
  );
  console.log(
    `Linux artifacts and latest-linux.yml are in ${libPath.relative(rootDir, releaseDir)}`
  );
}
