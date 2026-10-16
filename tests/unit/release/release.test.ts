import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error A plain ES module script without types.
import * as release from '../../../support/release/release.mjs';

const SCRIPT = libPath.resolve('support/release/release.mjs');
let directory: string;

beforeAll(async () => {
  directory = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-release-'));
});

afterAll(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

/** Packs a minimal npm tarball, as `npm pack` lays it out. */
async function tarball(fileName: string, manifest: object) {
  const source = await fs.mkdtemp(libPath.join(directory, 'source-'));
  await fs.mkdir(libPath.join(source, 'package'));
  await fs.writeFile(libPath.join(source, 'package/package.json'), JSON.stringify(manifest));
  const file = libPath.join(directory, fileName);
  execFileSync('tar', ['-czf', file, '-C', source, 'package']);
  return file;
}

/** Stands in for `npm view`: answers with JSON on stdout, or fails as npm does. */
const npmAnswering =
  (stdout: string, isFailure = false) =>
  () => {
    if (isFailure) {
      throw Object.assign(new Error('npm failed'), { stdout, status: 1 });
    }
    return stdout;
  };

const codeOf = (operation: () => unknown) => {
  try {
    operation();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return null;
};

describe('release tags', () => {
  it('accepts only stable version tags', () => {
    expect(release.stableVersionOf('v2.0.0')).toBe('2.0.0');
    expect(codeOf(() => release.stableVersionOf('v2.0.0-beta.1'))).toBe('PRERELEASE');
    for (const tag of ['2.0.0', 'v2.0', 'release-2', '', undefined]) {
      expect(codeOf(() => release.stableVersionOf(tag))).toBe('BAD_TAG');
    }
  });
});

describe('package versions', () => {
  it('must all be the tag’s version', () => {
    const lock = { version: '2.0.0', packages: { '': { version: '2.0.0' } } };
    expect(release.checkPackageVersions('v2.0.0', { version: '2.0.0' }, lock)).toBe('2.0.0');
    expect(codeOf(() => release.checkPackageVersions('v2.0.0', { version: '1.5.0' }, lock))).toBe(
      'BAD_PACKAGE'
    );
    expect(
      codeOf(() =>
        release.checkPackageVersions(
          'v2.0.0',
          { version: '2.0.0' },
          { version: '2.0.0', packages: { '': { version: '1.5.0' } } }
        )
      )
    ).toBe('BAD_PACKAGE');
  });
});

describe('release notes', () => {
  const readme = [
    '## Version history',
    '',
    '#### `2.0.0` (2026-10-16)',
    '',
    '- Introduce the desktop app',
    '',
    '#### `1.5.0` (2026-10-15)',
    '',
    '- Older change',
    '',
    '## License',
  ].join('\n');

  it('takes the version history entry of the release', () => {
    expect(release.releaseNotesOf(readme, '2.0.0')).toBe('- Introduce the desktop app');
    expect(release.releaseNotesOf(readme, '1.5.0')).toBe('- Older change');
  });

  it('fails without an entry, rather than releasing without notes', () => {
    expect(codeOf(() => release.releaseNotesOf(readme, '2.1.0'))).toBe('NO_RELEASE_NOTES');
  });
});

describe('npm tarball', () => {
  it('must be this package, at the tag’s version, with npm’s file name', async () => {
    const good = await tarball('pm2-captain-2.0.0.tgz', { name: 'pm2-captain', version: '2.0.0' });
    expect(release.checkTarball(good, 'v2.0.0')).toEqual({
      version: '2.0.0',
      integrity: release.integrityOf(good),
    });
    expect(release.integrityOf(good)).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);

    expect(codeOf(() => release.checkTarball(good, 'v2.0.1'))).toBe('BAD_PACKAGE');
    const other = await tarball('pm2-captain-2.0.0.tgz', { name: 'other', version: '2.0.0' });
    expect(codeOf(() => release.checkTarball(other, 'v2.0.0'))).toBe('BAD_PACKAGE');
    const renamed = await tarball('captain.tgz', { name: 'pm2-captain', version: '2.0.0' });
    expect(codeOf(() => release.checkTarball(renamed, 'v2.0.0'))).toBe('BAD_PACKAGE');
    const notTar = libPath.join(directory, 'pm2-captain-2.0.0-broken.tgz');
    await fs.writeFile(notTar, 'not a tarball');
    expect(codeOf(() => release.checkTarball(notTar, 'v2.0.0'))).toBe('BAD_PACKAGE');
  });
});

describe('npm publish plan', () => {
  it('publishes a version npm does not have', async () => {
    const file = await tarball('pm2-captain-2.0.0.tgz', { name: 'pm2-captain', version: '2.0.0' });
    const notFound = JSON.stringify({ error: { code: 'E404', summary: 'No match found' } });

    expect(release.planNpmPublish(file, 'v2.0.0', npmAnswering(notFound, true))).toMatchObject({
      action: 'publish',
      version: '2.0.0',
    });
  });

  it('succeeds on a rerun only for the identical archive', async () => {
    const file = await tarball('pm2-captain-2.0.0.tgz', { name: 'pm2-captain', version: '2.0.0' });
    const same = JSON.stringify(release.integrityOf(file));

    expect(release.planNpmPublish(file, 'v2.0.0', npmAnswering(same)).action).toBe(
      'already-published'
    );
    expect(
      codeOf(() => release.planNpmPublish(file, 'v2.0.0', npmAnswering('"sha512-other"')))
    ).toBe('MISMATCH');
  });

  it('fails on anything npm did not answer with "not found"', async () => {
    const file = await tarball('pm2-captain-2.0.0.tgz', { name: 'pm2-captain', version: '2.0.0' });
    const cases = [
      npmAnswering(JSON.stringify({ error: { code: 'ENOTFOUND' } }), true),
      npmAnswering(JSON.stringify({ error: { code: 'E401' } }), true),
      npmAnswering('', true),
      npmAnswering('null'),
    ];
    for (const run of cases) {
      expect(codeOf(() => release.planNpmPublish(file, 'v2.0.0', run))).toBe('REGISTRY_ERROR');
    }
  });
});

describe('GitHub release', () => {
  const complete = (overrides: object = {}) => ({
    tagName: 'v2.0.0',
    isDraft: false,
    isPrerelease: false,
    assets: release.requiredAssets('2.0.0').map((name: string) => ({ name })),
    ...overrides,
  });

  it('accepts a complete release in the expected state', () => {
    expect(release.checkRelease(complete(), 'v2.0.0', { isDraft: false })).toEqual({
      version: '2.0.0',
    });
    expect(release.checkRelease(complete({ isDraft: true }), 'v2.0.0', { isDraft: true })).toEqual({
      version: '2.0.0',
    });
  });

  it('rejects drafts, prereleases, other tags and malformed metadata', () => {
    const check = (metadata: unknown, isDraft = false) =>
      codeOf(() => release.checkRelease(metadata, 'v2.0.0', { isDraft }));
    expect(check(complete({ isDraft: true }))).toBe('BAD_RELEASE');
    expect(check(complete(), true)).toBe('BAD_RELEASE');
    expect(check(complete({ isPrerelease: true }))).toBe('PRERELEASE');
    expect(check(complete({ tagName: 'v1.9.0' }))).toBe('BAD_RELEASE');
    expect(check(complete({ assets: 'none' }))).toBe('BAD_RELEASE');
    expect(check(null)).toBe('BAD_RELEASE');
  });

  it('requires every asset, and exactly one npm tarball', () => {
    const assets = release.requiredAssets('2.0.0').map((name: string) => ({ name }));
    const check = (list: Array<{ name: string }>) =>
      codeOf(() => release.checkRelease(complete({ assets: list }), 'v2.0.0', { isDraft: false }));
    expect(check(assets.filter((asset: { name: string }) => asset.name !== 'latest-mac.yml'))).toBe(
      'MISSING_ASSET'
    );
    expect(check([...assets, { name: 'pm2-captain-1.9.0.tgz' }])).toBe('BAD_RELEASE');
    expect(
      check(assets.filter((asset: { name: string }) => !asset.name.endsWith('-release.json')))
    ).toBe('MISSING_ASSET');
  });

  it('with notes, requires the release body to be those notes', () => {
    const notes = '- Introduce the desktop app\n';
    const check = (overrides: object) =>
      codeOf(() =>
        release.checkRelease(complete({ isDraft: true, ...overrides }), 'v2.0.0', {
          isDraft: true,
          notes,
        })
      );
    expect(check({ body: '- Introduce the desktop app' })).toBeNull();
    expect(check({ body: '- Old notes' })).toBe('BAD_RELEASE');
    expect(check({})).toBe('BAD_RELEASE');
  });
});

describe('release metadata asset', () => {
  const COMMIT = 'a'.repeat(40);
  let file: string;
  let metadata: Record<string, unknown>;

  beforeAll(async () => {
    file = await tarball('pm2-captain-2.0.0.tgz', { name: 'pm2-captain', version: '2.0.0' });
    metadata = release.releaseMetadataOf(file, 'v2.0.0', COMMIT);
  });

  const check = (changed: unknown, commit = COMMIT, tarballFile: string | null = file) =>
    codeOf(() => release.checkMetadata(changed, 'v2.0.0', commit, tarballFile));

  it('ties the tag to the tested commit and the npm tarball', () => {
    expect(metadata).toEqual({
      schema: 1,
      tag: 'v2.0.0',
      version: '2.0.0',
      commit: COMMIT,
      npmPackage: { file: 'pm2-captain-2.0.0.tgz', integrity: release.integrityOf(file) },
    });
    expect(release.checkMetadata(metadata, 'v2.0.0', COMMIT, file)).toEqual({
      version: '2.0.0',
      commit: COMMIT,
      integrity: release.integrityOf(file),
    });
    expect(codeOf(() => release.releaseMetadataOf(file, 'v2.0.0', 'abc123'))).toBe('BAD_METADATA');
  });

  it('rejects malformed metadata and other schemas', () => {
    expect(check(null)).toBe('BAD_METADATA');
    expect(check('text')).toBe('BAD_METADATA');
    expect(check({ ...metadata, schema: 2 })).toBe('BAD_METADATA');
    expect(check({ ...metadata, commit: undefined })).toBe('BAD_METADATA');
    expect(check({ ...metadata, npmPackage: undefined })).toBe('BAD_METADATA');
    expect(check({ ...metadata, npmPackage: { file: 'pm2-captain-2.0.0.tgz' } })).toBe(
      'BAD_METADATA'
    );
  });

  it('rejects another tag, version, commit or tarball', async () => {
    expect(check({ ...metadata, tag: 'v2.0.1' })).toBe('BAD_METADATA');
    expect(check({ ...metadata, version: '2.0.1' })).toBe('BAD_METADATA');
    expect(check(metadata, 'b'.repeat(40))).toBe('BAD_METADATA');
    expect(check({ ...metadata, npmPackage: { file: 'other.tgz', integrity: 'sha512-x' } })).toBe(
      'BAD_METADATA'
    );
    expect(
      check({ ...metadata, npmPackage: { file: 'pm2-captain-2.0.0.tgz', integrity: 'sha512-x' } })
    ).toBe('BAD_METADATA');

    // Same name and version, different archive: a rebuilt or swapped tarball.
    const rebuilt = libPath.join(directory, 'rebuilt');
    await fs.mkdir(rebuilt);
    const swapped = await tarball('rebuilt/pm2-captain-2.0.0.tgz', {
      name: 'pm2-captain',
      version: '2.0.0',
      description: 'rebuilt',
    });
    expect(check(metadata, COMMIT, swapped)).toBe('BAD_METADATA');
  });
});

describe('release command line', () => {
  it('exits with a code for each kind of failure', async () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    const file = await tarball('pm2-captain-2.0.0.tgz', { name: 'pm2-captain', version: '2.0.0' });

    expect(run('check-tarball', file, 'v2.0.0').status).toBe(0);
    expect(run('check-tarball', file, 'v2.0.0-rc.1').status).toBe(release.EXIT_CODES.PRERELEASE);
    expect(run('check-tarball', file, 'v2.0.1').status).toBe(release.EXIT_CODES.BAD_PACKAGE);
    expect(run('notes', '0.0.1').status).toBe(release.EXIT_CODES.NO_RELEASE_NOTES);
    expect(run('notes', '1.5.0').stdout).toContain('Log page header');
    expect(run('publish').status).toBe(release.EXIT_CODES.USAGE);
    const commit = 'c'.repeat(40);
    const metadataFile = libPath.join(directory, 'metadata.json');
    const created = run('metadata', file, 'v2.0.0', commit);
    expect(created.status).toBe(0);
    await fs.writeFile(metadataFile, created.stdout);
    expect(run('check-metadata', metadataFile, 'v2.0.0', commit, file).status).toBe(0);
    expect(run('check-metadata', metadataFile, 'v2.0.0', 'd'.repeat(40), file).status).toBe(
      release.EXIT_CODES.BAD_METADATA
    );
    expect(run('check-metadata', file, 'v2.0.0', commit, file).status).toBe(
      release.EXIT_CODES.BAD_METADATA
    );

    const releaseFile = libPath.join(directory, 'release.json');
    const notesFile = libPath.join(directory, 'notes.md');
    await fs.writeFile(notesFile, '- Notes\n');
    await fs.writeFile(
      releaseFile,
      JSON.stringify({
        tagName: 'v2.0.0',
        isDraft: true,
        isPrerelease: false,
        body: '- Stale notes',
        assets: release.requiredAssets('2.0.0').map((name: string) => ({ name })),
      })
    );
    expect(run('check-release', releaseFile, 'v2.0.0', '--draft').status).toBe(0);
    expect(
      run('check-release', releaseFile, 'v2.0.0', '--draft', '--notes', notesFile).status
    ).toBe(release.EXIT_CODES.BAD_RELEASE);
    expect(run('check-release', releaseFile, 'v2.0.0', '--notes').status).toBe(
      release.EXIT_CODES.USAGE
    );
    // No checkout of this project is ever version 0.0.0.
    expect(run('check-version', 'v0.0.0').status).toBe(release.EXIT_CODES.BAD_PACKAGE);
  });
});
