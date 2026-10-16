// Release helpers for the GitHub workflows: release notes from the README, and
// checks of the npm tarball that a draft release carries and the npm publish
// workflow publishes. Plain Node, no dependencies.
//
// Usage:
//   node support/release/release.mjs notes <version>
//     Prints the README version history entry of that version.
//   node support/release/release.mjs check-version <tag>
//     Checks that package.json and package-lock.json hold the tag's version.
//   node support/release/release.mjs check-tarball <file.tgz> <tag>
//     Checks that the tarball is the npm package of a stable version tag.
//   node support/release/release.mjs metadata <file.tgz> <tag> <commit>
//     Prints the release metadata asset: the tag, the tested commit and the
//     npm tarball's name and integrity.
//   node support/release/release.mjs check-metadata <metadata.json> <tag> <commit> <file.tgz>
//     Checks that metadata belongs to the tag and commit, and the tarball to it.
//   node support/release/release.mjs check-release <release.json> <tag> [--draft] [--notes <file>]
//     Checks `gh release view --json tagName,isDraft,isPrerelease,assets[,body]`
//     output: the release state, the complete set of release assets and, with
//     --notes, that the release notes are that file's.
//   node support/release/release.mjs npm-plan <file.tgz> <tag>
//     Also asks npm whether that version exists. Prints and, in GitHub Actions,
//     writes `action=publish` or `action=already-published` to $GITHUB_OUTPUT.
//     An already published version must have the same integrity.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import libPath from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'pm2-captain';

/** A failure with a stable code; the command line exits with its exit code. */
export class ReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
  }
}

export const EXIT_CODES = {
  USAGE: 2,
  BAD_TAG: 3,
  PRERELEASE: 4,
  BAD_PACKAGE: 5,
  NO_RELEASE_NOTES: 6,
  MISMATCH: 7,
  REGISTRY_ERROR: 8,
  BAD_RELEASE: 9,
  MISSING_ASSET: 10,
  BAD_METADATA: 11,
};

/** The version of the release metadata format; a reader accepts only this one. */
export const METADATA_SCHEMA = 1;

/** The release metadata asset of a version. */
export const metadataFileOf = version => `${PACKAGE_NAME}-${version}-release.json`;

/** Everything a complete release carries: the desktop builds, their manifests, the npm package. */
export function requiredAssets(version) {
  return [
    `${PACKAGE_NAME}-${version}.tgz`,
    metadataFileOf(version),
    'latest-linux.yml',
    'latest-mac.yml',
    'PM2-Captain-x86_64.AppImage',
    `pm2-captain-desktop_${version}_amd64.deb`,
    `pm2-captain-desktop-${version}.x86_64.rpm`,
    `PM2-Captain-${version}-arm64.dmg`,
    `PM2-Captain-${version}-arm64.zip`,
    `PM2-Captain-${version}-x64.dmg`,
    `PM2-Captain-${version}-x64.zip`,
  ];
}

/**
 * Checks a release as GitHub describes it: its tag, that it is a draft (or
 * published) and not a prerelease, and that every required asset is there,
 * with exactly one npm tarball.
 */
export function checkRelease(release, tag, { isDraft, notes = null }) {
  const version = stableVersionOf(tag);
  if (
    typeof release !== 'object' ||
    release === null ||
    typeof release.tagName !== 'string' ||
    typeof release.isDraft !== 'boolean' ||
    typeof release.isPrerelease !== 'boolean' ||
    !Array.isArray(release.assets) ||
    !release.assets.every(asset => typeof asset?.name === 'string')
  ) {
    throw new ReleaseError('BAD_RELEASE', `The release metadata of ${tag} is incomplete.`);
  }
  if (release.tagName !== tag) {
    throw new ReleaseError('BAD_RELEASE', `The release is for ${release.tagName}, not ${tag}.`);
  }
  if (release.isPrerelease) {
    throw new ReleaseError('PRERELEASE', `The ${tag} release is marked as a prerelease.`);
  }
  if (release.isDraft !== isDraft) {
    throw new ReleaseError(
      'BAD_RELEASE',
      `The ${tag} release is ${release.isDraft ? 'still a draft' : 'already published'}.`
    );
  }
  const names = release.assets.map(asset => asset.name);
  const missing = requiredAssets(version).filter(name => !names.includes(name));
  if (missing.length) {
    throw new ReleaseError('MISSING_ASSET', `The ${tag} release lacks ${missing.join(', ')}.`);
  }
  const tarballs = names.filter(name => /^pm2-captain-.*\.tgz$/.test(name));
  if (tarballs.length !== 1) {
    throw new ReleaseError(
      'BAD_RELEASE',
      `The ${tag} release has ${tarballs.length} npm tarballs.`
    );
  }
  if (
    notes !== null &&
    (typeof release.body !== 'string' || release.body.trim() !== notes.trim())
  ) {
    throw new ReleaseError(
      'BAD_RELEASE',
      `The ${tag} release notes are not the README version history entry.`
    );
  }
  return { version };
}

/** The release metadata asset that ties a tag to its tested commit and npm tarball. */
export function releaseMetadataOf(file, tag, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
    throw new ReleaseError('BAD_METADATA', `"${commit}" is not a full commit hash.`);
  }
  const { version, integrity } = checkTarball(file, tag);
  return {
    schema: METADATA_SCHEMA,
    tag,
    version,
    commit,
    npmPackage: { file: libPath.basename(file), integrity },
  };
}

/**
 * Checks release metadata against the tag and the commit the run is for, and,
 * with a tarball, that the tarball is the one it names.
 */
export function checkMetadata(metadata, tag, commit, file = null) {
  const version = stableVersionOf(tag);
  const fail = reason => {
    throw new ReleaseError('BAD_METADATA', `The ${tag} release metadata ${reason}.`);
  };
  if (typeof metadata !== 'object' || metadata === null) {
    fail('is not an object');
  }
  if (metadata.schema !== METADATA_SCHEMA) {
    fail(`has schema ${JSON.stringify(metadata.schema)}, not ${METADATA_SCHEMA}`);
  }
  if (metadata.tag !== tag || metadata.version !== version) {
    fail(`is for ${metadata.tag} ${metadata.version}`);
  }
  if (typeof metadata.commit !== 'string' || !/^[0-9a-f]{40}$/.test(metadata.commit)) {
    fail('has no full commit hash');
  }
  if (metadata.commit !== commit) {
    fail(`names commit ${metadata.commit}, not ${commit}`);
  }
  const npmPackage = metadata.npmPackage;
  if (npmPackage?.file !== `${PACKAGE_NAME}-${version}.tgz`) {
    fail(`names the npm tarball ${npmPackage?.file}`);
  }
  if (typeof npmPackage.integrity !== 'string' || !npmPackage.integrity.startsWith('sha512-')) {
    fail('has no sha512 integrity');
  }
  if (file !== null) {
    const checked = checkTarball(file, tag);
    if (libPath.basename(file) !== npmPackage.file || checked.integrity !== npmPackage.integrity) {
      fail(`does not describe ${file} (${checked.integrity})`);
    }
  }
  return { version, commit: metadata.commit, integrity: npmPackage.integrity };
}

/** The version of a stable release tag, `v1.2.3`. Prereleases are not published. */
export function stableVersionOf(tag) {
  const match = /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/.exec(tag ?? '');
  if (!match) {
    throw new ReleaseError('BAD_TAG', `"${tag}" is not a version tag such as v1.2.3.`);
  }
  if (match[2]) {
    throw new ReleaseError(
      'PRERELEASE',
      `${tag} is a prerelease; only stable versions are released.`
    );
  }
  return match[1];
}

/** The README "Version history" entry of a version, without its heading. */
export function releaseNotesOf(readme, version) {
  const lines = readme.split('\n');
  const start = lines.findIndex(line => line.startsWith(`#### \`${version}\``));
  if (start < 0) {
    throw new ReleaseError(
      'NO_RELEASE_NOTES',
      `README.md has no version history entry for ${version}.`
    );
  }
  const end = lines.findIndex((line, index) => index > start && /^#{1,4} /.test(line));
  const notes = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
  if (!notes) {
    throw new ReleaseError('NO_RELEASE_NOTES', `The ${version} entry in README.md is empty.`);
  }
  return notes;
}

/** Checks that package.json and both versions in package-lock.json are the tag's. */
export function checkPackageVersions(tag, manifest, lock) {
  const version = stableVersionOf(tag);
  const found = [manifest?.version, lock?.version, lock?.packages?.['']?.version];
  if (found.some(value => value !== version)) {
    throw new ReleaseError(
      'BAD_PACKAGE',
      `package.json and package-lock.json hold ${found.join(', ')}, not ${version}.`
    );
  }
  return version;
}

/** npm's integrity string for a file: sha512, base64. */
export function integrityOf(file) {
  return `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
}

/** Checks that a tarball is this package at the tag's version, and returns its integrity. */
export function checkTarball(file, tag) {
  const version = stableVersionOf(tag);
  let manifest;
  try {
    manifest = JSON.parse(
      execFileSync('tar', ['-xzOf', file, 'package/package.json'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    );
  } catch {
    throw new ReleaseError('BAD_PACKAGE', `${file} is not an npm package tarball.`);
  }
  if (manifest.name !== PACKAGE_NAME || manifest.version !== version) {
    throw new ReleaseError(
      'BAD_PACKAGE',
      `${file} holds ${manifest.name}@${manifest.version}, not ${PACKAGE_NAME}@${version}.`
    );
  }
  if (libPath.basename(file) !== `${PACKAGE_NAME}-${version}.tgz`) {
    throw new ReleaseError(
      'BAD_PACKAGE',
      `${file} should be named ${PACKAGE_NAME}-${version}.tgz.`
    );
  }
  return { version, integrity: integrityOf(file) };
}

/**
 * The integrity npm has for a published version, or null when the version is
 * not published. npm's JSON error code tells "not found" from other failures.
 */
export function publishedIntegrity(version, run = execFileSync) {
  try {
    const output = run('npm', ['view', `${PACKAGE_NAME}@${version}`, 'dist.integrity', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const integrity = JSON.parse(output || 'null');
    if (typeof integrity !== 'string') {
      throw new ReleaseError('REGISTRY_ERROR', `npm reported no integrity for ${version}.`);
    }
    return integrity;
  } catch (error) {
    if (error instanceof ReleaseError) {
      throw error;
    }
    let code = null;
    try {
      code = JSON.parse(String(error.stdout ?? '')).error?.code ?? null;
    } catch {
      // Not npm's JSON error: a network or tool failure.
    }
    if (code === 'E404') {
      return null;
    }
    throw new ReleaseError(
      'REGISTRY_ERROR',
      `Unable to ask npm about ${PACKAGE_NAME}@${version} (${code ?? 'no npm error code'}).`
    );
  }
}

/** Whether to publish the tarball: only once, and a rerun only for the same archive. */
export function planNpmPublish(file, tag, run = execFileSync) {
  const { version, integrity } = checkTarball(file, tag);
  const published = publishedIntegrity(version, run);
  if (published === null) {
    return { action: 'publish', version, integrity };
  }
  if (published !== integrity) {
    throw new ReleaseError(
      'MISMATCH',
      `${PACKAGE_NAME}@${version} is already published with a different archive (${published}, this one is ${integrity}).`
    );
  }
  return { action: 'already-published', version, integrity };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'notes' && args.length === 1) {
      const readme = readFileSync(
        libPath.resolve(libPath.dirname(fileURLToPath(import.meta.url)), '../../README.md'),
        'utf8'
      );
      process.stdout.write(`${releaseNotesOf(readme, args[0])}\n`);
    } else if (command === 'check-version' && args.length === 1) {
      const root = libPath.resolve(libPath.dirname(fileURLToPath(import.meta.url)), '../..');
      const read = name => JSON.parse(readFileSync(libPath.join(root, name), 'utf8'));
      console.log(checkPackageVersions(args[0], read('package.json'), read('package-lock.json')));
    } else if (command === 'check-tarball' && args.length === 2) {
      const { version, integrity } = checkTarball(args[0], args[1]);
      console.log(`${PACKAGE_NAME}@${version} ${integrity}`);
    } else if (command === 'metadata' && args.length === 3) {
      console.log(JSON.stringify(releaseMetadataOf(args[0], args[1], args[2]), null, 2));
    } else if (command === 'check-metadata' && args.length === 4) {
      let metadata;
      try {
        metadata = JSON.parse(readFileSync(args[0], 'utf8'));
      } catch {
        throw new ReleaseError('BAD_METADATA', `${args[0]} is not release metadata.`);
      }
      const { commit, integrity } = checkMetadata(metadata, args[1], args[2], args[3]);
      console.log(`${args[1]} is commit ${commit}, npm tarball ${integrity}`);
    } else if (command === 'check-release' && args.length >= 2) {
      const [file, tag, ...flags] = args;
      const isDraft = flags[0] === '--draft';
      const options = isDraft ? flags.slice(1) : flags;
      if (options.length && (options.length !== 2 || options[0] !== '--notes')) {
        throw new ReleaseError(
          'USAGE',
          'Usage: check-release <release.json> <tag> [--draft] [--notes <file>]'
        );
      }
      let release;
      try {
        release = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        throw new ReleaseError('BAD_RELEASE', `${file} is not release metadata.`);
      }
      const notes = options.length ? readFileSync(options[1], 'utf8') : null;
      const { version } = checkRelease(release, tag, { isDraft, notes });
      console.log(`The ${tag} release is complete (${version}).`);
    } else if (command === 'npm-plan' && args.length === 2) {
      const plan = planNpmPublish(args[0], args[1]);
      console.log(`${plan.action}: ${PACKAGE_NAME}@${plan.version} ${plan.integrity}`);
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          `action=${plan.action}\nversion=${plan.version}\n`
        );
      }
    } else {
      throw new ReleaseError(
        'USAGE',
        'Usage: release.mjs notes <version> | check-version <tag> | check-tarball <file.tgz> <tag> | metadata <file.tgz> <tag> <commit> | check-metadata <metadata.json> <tag> <commit> <file.tgz> | check-release <release.json> <tag> [--draft] [--notes <file>] | npm-plan <file.tgz> <tag>'
      );
    }
  } catch (error) {
    if (!(error instanceof ReleaseError)) {
      throw error;
    }
    console.error(`${error.code}: ${error.message}`);
    process.exit(EXIT_CODES[error.code] ?? 1);
  }
}
