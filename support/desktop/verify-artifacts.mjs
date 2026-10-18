// Checks built desktop artifacts before they are uploaded or published:
// update manifests and their checksums, the updater type baked into each Linux
// package, the desktop identity, Electron fuses and the packaged app contents.
//
// Usage: node support/desktop/verify-artifacts.mjs [releaseDir] [--targets appimage,deb,rpm,mac,manifests]
// "manifests" checks only the update manifests of a complete release.
import { listPackage } from '@electron/asar';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import yaml from 'js-yaml';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELEASE_PLATFORMS } from '../release/release.mjs';

const rootDir = libPath.resolve(libPath.dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE_NAME = 'pm2-captain-desktop';
const INSTALL_DIR = 'opt/PM2 Captain';
const PUBLISH = { provider: 'github', owner: 'panta82', repo: 'pm2-captain' };

const args = process.argv.slice(2);
const targetsIndex = args.indexOf('--targets');
const targets = new Set(
  (targetsIndex >= 0 ? args[targetsIndex + 1] : 'appimage,deb,rpm').split(',')
);
const releaseDir = libPath.resolve(
  rootDir,
  args.find((argument, index) => !argument.startsWith('--') && index !== targetsIndex + 1) ??
    'build/desktop/release'
);
const version = JSON.parse(readFileSync(libPath.join(rootDir, 'package.json'), 'utf8')).version;

const failures = [];
const passes = [];
const check = (condition, message) => (condition ? passes : failures).push(message);
const temporaryDirs = [];
const temporaryDir = () => {
  const directory = mkdtempSync(libPath.join(libOs.tmpdir(), 'pm2c-verify-'));
  temporaryDirs.push(directory);
  return directory;
};
const has = command => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;

const sha512 = path => createHash('sha512').update(readFileSync(path)).digest('base64');

/** Checks a manifest's version, and the size and checksum of every file it names. */
function verifyManifest(name) {
  const path = libPath.join(releaseDir, name);
  if (!existsSync(path)) {
    check(false, `${name} exists`);
    return null;
  }
  const manifest = yaml.load(readFileSync(path, 'utf8'));
  check(manifest.version === version, `${name} has version ${version} (found ${manifest.version})`);
  for (const file of manifest.files ?? []) {
    const filePath = libPath.join(releaseDir, file.url);
    if (!existsSync(filePath)) {
      check(false, `${name}: ${file.url} exists`);
      continue;
    }
    check(statSync(filePath).size === file.size, `${name}: ${file.url} size matches`);
    check(sha512(filePath) === file.sha512, `${name}: ${file.url} sha512 matches`);
  }
  return manifest;
}

/** Checks a packaged app's resources directory. */
function verifyResources(label, resourcesDir, expectedPackageType) {
  const packageTypePath = libPath.join(resourcesDir, 'package-type');
  const packageType = existsSync(packageTypePath)
    ? readFileSync(packageTypePath, 'utf8').trim()
    : null;
  // electron-updater picks its DEB, RPM or AppImage updater from this file.
  check(
    packageType === expectedPackageType,
    `${label}: package-type is ${expectedPackageType ?? 'absent'} (found ${packageType ?? 'absent'})`
  );
  const updateConfigPath = libPath.join(resourcesDir, 'app-update.yml');
  const updateConfig = existsSync(updateConfigPath)
    ? yaml.load(readFileSync(updateConfigPath, 'utf8'))
    : null;
  check(
    updateConfig?.provider === PUBLISH.provider &&
      updateConfig.owner === PUBLISH.owner &&
      updateConfig.repo === PUBLISH.repo,
    `${label}: app-update.yml points at ${PUBLISH.owner}/${PUBLISH.repo}`
  );

  const asarPath = libPath.join(resourcesDir, 'app.asar');
  const files = new Set(listPackage(asarPath).map(file => file.replaceAll('\\', '/')));
  const manifest = JSON.parse(
    execFileSync(process.execPath, [
      '-e',
      `process.stdout.write(require('@electron/asar').extractFile(${JSON.stringify(asarPath)}, 'package.json').toString())`,
    ])
  );
  check(
    manifest.name === PACKAGE_NAME && manifest.version === version,
    `${label}: app is ${PACKAGE_NAME} ${version}`
  );
  for (const required of [
    '/dist/desktop/main.js',
    '/dist/desktop/preload.js',
    '/dist/desktop/backend/desktop_backend.js',
    '/dist/backend/app.js',
    '/dist/frontend/index.html',
    '/node_modules/pm2/lib/API.js',
    '/node_modules/proper-lockfile/package.json',
  ]) {
    check(files.has(required), `${label}: app contains ${required}`);
  }
  for (const forbidden of [
    '/node_modules/electron-updater',
    '/node_modules/electron',
    '/src',
    '/tests',
  ]) {
    check(
      ![...files].some(file => file === forbidden || file.startsWith(`${forbidden}/`)),
      `${label}: app does not contain ${forbidden}`
    );
  }
  check(![...files].some(file => file.endsWith('.map')), `${label}: app contains no source maps`);
}

function verifyFuses(label, executable) {
  const wire = getCurrentFuseWire(executable);
  return wire.then(fuses => {
    // The wire holds the characters '0' and '1'.
    const isOn = option => String.fromCharCode(fuses[option]) === '1';
    check(!isOn(FuseV1Options.RunAsNode), `${label}: RunAsNode fuse is off`);
    check(
      !isOn(FuseV1Options.EnableNodeOptionsEnvironmentVariable),
      `${label}: NODE_OPTIONS fuse is off`
    );
    check(
      !isOn(FuseV1Options.EnableNodeCliInspectArguments),
      `${label}: inspect arguments fuse is off`
    );
    check(isOn(FuseV1Options.OnlyLoadAppFromAsar), `${label}: only loads app.asar`);
  });
}

/** Icons must be in hicolor's standard size directories to be found by menu and window themes. */
function verifyLinuxIcons(label, root, desktopEntry) {
  check(
    /^Icon=pm2-captain-desktop$/m.test(desktopEntry),
    `${label}: desktop entry uses the packaged icon name`
  );
  check(
    /^StartupWMClass=pm2-captain-desktop$/m.test(desktopEntry),
    `${label}: desktop entry matches the window class`
  );
  for (const size of [16, 24, 32, 48, 64, 96, 128, 256, 512]) {
    const path = libPath.join(
      root,
      `usr/share/icons/hicolor/${size}x${size}/apps/${PACKAGE_NAME}.png`
    );
    const png = existsSync(path) ? readFileSync(path) : null;
    check(
      png !== null &&
        png.length >= 24 &&
        png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
        png.toString('ascii', 12, 16) === 'IHDR' &&
        png.readUInt32BE(16) === size &&
        png.readUInt32BE(20) === size,
      `${label}: ${size}px menu icon exists with matching PNG dimensions`
    );
  }
}

/** Checks the desktop entry and that nothing claims the npm command's name. */
function verifyLinuxFiles(label, root, installScripts) {
  const desktopEntryPath = libPath.join(root, 'usr/share/applications', `${PACKAGE_NAME}.desktop`);
  const desktopEntry = existsSync(desktopEntryPath) ? readFileSync(desktopEntryPath, 'utf8') : '';
  verifyLinuxIcons(label, root, desktopEntry);
  check(
    desktopEntry.includes(`Exec="/${INSTALL_DIR}/${PACKAGE_NAME}"`),
    `${label}: desktop entry runs ${PACKAGE_NAME}`
  );
  check(!desktopEntry.includes('--no-sandbox'), `${label}: desktop entry keeps the sandbox`);
  check(
    !existsSync(libPath.join(root, 'usr/bin/pm2-captain')),
    `${label}: does not install /usr/bin/pm2-captain`
  );
  check(
    !/\/usr\/bin\/pm2-captain(['"\s]|$)/m.test(installScripts),
    `${label}: install scripts do not touch /usr/bin/pm2-captain`
  );
  check(
    installScripts.includes(`/usr/bin/${PACKAGE_NAME}`),
    `${label}: install scripts link /usr/bin/${PACKAGE_NAME}`
  );
}

const isElf = path => {
  try {
    return readFileSync(path).subarray(0, 4).toString('latin1') === '\x7fELF';
  } catch {
    return false;
  }
};

/** The offset of the squashfs image after an AppImage's ELF runtime. */
function appImageOffset(path) {
  const header = Buffer.alloc(64);
  const descriptor = openSync(path, 'r');
  readSync(descriptor, header, 0, 64, 0);
  closeSync(descriptor);
  // 64-bit little-endian ELF: section headers end the runtime.
  const sectionHeaderOffset = Number(header.readBigUInt64LE(0x28));
  const sectionHeaderSize = header.readUInt16LE(0x3a);
  const sectionHeaderCount = header.readUInt16LE(0x3c);
  return sectionHeaderOffset + sectionHeaderSize * sectionHeaderCount;
}

async function verifyLinux() {
  const manifest = verifyManifest('latest-linux.yml');
  if (!manifest) {
    return;
  }
  const urls = (manifest.files ?? []).map(file => file.url);
  const expected = {
    appimage: 'PM2-Captain-x86_64.AppImage',
    deb: `${PACKAGE_NAME}_${version}_amd64.deb`,
    rpm: `${PACKAGE_NAME}-${version}.x86_64.rpm`,
  };
  for (const [target, file] of Object.entries(expected)) {
    if (targets.has(target)) {
      check(urls.includes(file), `latest-linux.yml lists ${file}`);
    }
  }

  const unpacked = libPath.join(releaseDir, 'linux-unpacked');
  if (existsSync(unpacked)) {
    await verifyFuses('linux-unpacked', libPath.join(unpacked, PACKAGE_NAME));
  }

  if (targets.has('deb')) {
    const deb = libPath.join(releaseDir, expected.deb);
    const fields = execFileSync('dpkg-deb', [
      '--showformat=${Package}\\n${Version}\\n${Architecture}\\n',
      '--show',
      deb,
    ])
      .toString()
      .trim()
      .split('\n');
    check(
      fields.join(' ') === `${PACKAGE_NAME} ${version} amd64`,
      `deb: control fields are ${PACKAGE_NAME} ${version} amd64 (found ${fields.join(' ')})`
    );
    const root = temporaryDir();
    execFileSync('dpkg-deb', ['-x', deb, root]);
    const control = temporaryDir();
    execFileSync('dpkg-deb', ['-e', deb, control]);
    const scripts = readdirSync(control)
      .filter(file => ['postinst', 'postrm', 'preinst', 'prerm'].includes(file))
      .map(file => readFileSync(libPath.join(control, file), 'utf8'))
      .join('\n');
    verifyResources('deb', libPath.join(root, INSTALL_DIR, 'resources'), 'deb');
    verifyLinuxFiles('deb', root, scripts);
    // The AppArmor profile attaches to this path, so it must be Electron itself.
    check(isElf(libPath.join(root, INSTALL_DIR, PACKAGE_NAME)), 'deb: the executable is Electron');
    check(
      scripts.includes('apparmor-profile'),
      'deb: installs the AppArmor profile for the sandbox'
    );
    await verifyFuses('deb', libPath.join(root, INSTALL_DIR, PACKAGE_NAME));
  }

  if (targets.has('rpm')) {
    const rpm = libPath.join(releaseDir, expected.rpm);
    if (!existsSync(rpm)) {
      check(false, `rpm: ${expected.rpm} exists`);
    } else if (!has('rpm') || !has('rpm2cpio')) {
      check(false, 'rpm: rpm and rpm2cpio are available to inspect the package');
    } else {
      const fields = execFileSync('rpm', [
        '--query',
        '--package',
        '--queryformat',
        '%{NAME} %{VERSION} %{ARCH}',
        rpm,
      ]).toString();
      check(
        fields === `${PACKAGE_NAME} ${version} x86_64`,
        `rpm: header is ${PACKAGE_NAME} ${version} x86_64 (found ${fields})`
      );
      const root = temporaryDir();
      execFileSync('sh', ['-c', 'rpm2cpio "$1" | (cd "$2" && cpio -idm --quiet)', 'sh', rpm, root]);
      const scripts = execFileSync('rpm', ['--query', '--package', '--scripts', rpm]).toString();
      verifyResources('rpm', libPath.join(root, INSTALL_DIR, 'resources'), 'rpm');
      verifyLinuxFiles('rpm', root, scripts);
      check(
        isElf(libPath.join(root, INSTALL_DIR, PACKAGE_NAME)),
        'rpm: the executable is Electron'
      );
      await verifyFuses('rpm', libPath.join(root, INSTALL_DIR, PACKAGE_NAME));
    }
  }

  if (targets.has('appimage')) {
    const appImage = libPath.join(releaseDir, expected.appimage);
    check(!/\d+\.\d+\.\d+/.test(expected.appimage), 'appimage: file name has no version');
    const root = libPath.join(temporaryDir(), 'root');
    execFileSync('unsquashfs', [
      '-q',
      '-o',
      String(appImageOffset(appImage)),
      '-d',
      root,
      appImage,
    ]);
    // No package-type: electron-updater uses its AppImage updater.
    verifyResources('appimage', libPath.join(root, 'resources'), null);
    const desktopEntry = readdirSync(root).find(file => file.endsWith('.desktop'));
    const entry = desktopEntry ? readFileSync(libPath.join(root, desktopEntry), 'utf8') : '';
    verifyLinuxIcons('appimage', root, entry);
    const mainIcon = libPath.join(root, `${PACKAGE_NAME}.png`);
    const directoryIcon = libPath.join(root, '.DirIcon');
    const themeIcon = libPath.join(
      root,
      `usr/share/icons/hicolor/512x512/apps/${PACKAGE_NAME}.png`
    );
    check(
      [mainIcon, directoryIcon, themeIcon].every(path => existsSync(path)) &&
        readFileSync(mainIcon).equals(readFileSync(themeIcon)) &&
        readFileSync(directoryIcon).equals(readFileSync(themeIcon)),
      'appimage: root icon and .DirIcon resolve to the 512px theme icon'
    );
    check(!entry.includes('--no-sandbox'), 'appimage: desktop entry keeps the sandbox');
    // Our launcher replaces the executable, so AppRun's --no-sandbox never reaches Electron.
    check(
      readFileSync(libPath.join(root, PACKAGE_NAME), 'utf8') ===
        readFileSync(libPath.join(rootDir, 'support/desktop/appimage/launcher.sh'), 'utf8'),
      'appimage: the executable is the sandbox-keeping launcher'
    );
    check(
      isElf(libPath.join(root, `${PACKAGE_NAME}.bin`)),
      'appimage: Electron is pm2-captain-desktop.bin'
    );
    await verifyFuses('appimage', libPath.join(root, `${PACKAGE_NAME}.bin`));
  }
}

function verifyMac() {
  const manifest = verifyManifest('latest-mac.yml');
  if (!manifest) {
    return;
  }
  const zips = (manifest.files ?? []).filter(file => file.url.endsWith('.zip'));
  for (const arch of ['arm64', 'x64']) {
    check(
      zips.some(file => file.url === `PM2-Captain-${version}-${arch}.zip`),
      `latest-mac.yml lists the ${arch} ZIP`
    );
    check(
      existsSync(libPath.join(releaseDir, `PM2-Captain-${version}-${arch}.dmg`)),
      `the ${arch} DMG exists`
    );
    // The release workflow signs, verifies and launches this bundle path.
    const zip = libPath.join(releaseDir, `PM2-Captain-${version}-${arch}.zip`);
    const entries = existsSync(zip)
      ? execFileSync('unzip', ['-Z1', zip]).toString().split('\n')
      : [];
    check(
      entries.includes('PM2 Captain.app/Contents/MacOS/PM2 Captain'),
      `the ${arch} ZIP holds PM2 Captain.app with the executable PM2 Captain`
    );
  }
}

/** Before upload: enabled platforms' manifests list every expected file, and every file matches. */
function verifyReleaseManifests() {
  const linux = verifyManifest('latest-linux.yml');
  const linuxUrls = (linux?.files ?? []).map(file => file.url);
  for (const file of [
    'PM2-Captain-x86_64.AppImage',
    `${PACKAGE_NAME}_${version}_amd64.deb`,
    `${PACKAGE_NAME}-${version}.x86_64.rpm`,
  ]) {
    check(linuxUrls.includes(file), `latest-linux.yml lists ${file}`);
  }
  if (RELEASE_PLATFORMS.includes('mac')) {
    verifyMac();
  }
}

try {
  if (targets.has('manifests')) {
    verifyReleaseManifests();
  }
  if (['appimage', 'deb', 'rpm'].some(target => targets.has(target))) {
    await verifyLinux();
  }
  if (targets.has('mac')) {
    verifyMac();
  }
} finally {
  for (const directory of temporaryDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const message of passes) {
  console.log(`ok    ${message}`);
}
for (const message of failures) {
  console.log(`FAIL  ${message}`);
}
console.log(`\n${passes.length} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
