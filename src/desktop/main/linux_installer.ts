import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import libPath from 'node:path';
import { promisify } from 'node:util';

import type { IFileLog } from './desktop_log';

/** The Linux package name, which never collides with the npm `pm2-captain` command. */
export const LINUX_PACKAGE_NAME = 'pm2-captain-desktop';

const PKEXEC = '/usr/bin/pkexec';
const PACKAGE_TOOLS: Record<ILinuxPackageType, { install: string; inspect: string }> = {
  deb: { install: '/usr/bin/dpkg', inspect: '/usr/bin/dpkg-deb' },
  rpm: { install: '/usr/bin/rpm', inspect: '/usr/bin/rpm' },
};
/**
 * pkexec exits 126 when the user dismisses the authentication dialog, and 127
 * when authorization could not be obtained or the program could not run; the
 * package manager never started. See pkexec(1).
 *
 * The package managers cannot produce these codes for this command. dpkg
 * exits 0, 1 or 2 (dpkg(1), EXIT STATUS). rpm 4.20 exits with the number of
 * failed packages, capped at 254 (tools/rpm.c, tools/cliutils.h RETVAL): for
 * one package that is 1, or the transaction's element count (the install plus
 * the erasure of the installed version) when its checks fail before anything
 * is changed (lib/rpminstall.c rpmcliTransaction, lib/transaction.c rpmtsRun).
 */
const NOT_STARTED_EXIT_CODES = new Set([126, 127]);
const MARKER_FILE = 'update-install.json';
const LOG_FILE = 'update-install.log';

export type ILinuxPackageType = 'deb' | 'rpm';

export interface ILinuxInstallRequest {
  packageType: ILinuxPackageType;
  file: string;
  version: string;
  /** Base64 SHA-512 from the update manifest. */
  sha512: string;
}

export type ILinuxInstallOutcome =
  | { kind: 'installed' }
  /** Nothing was changed; the app can continue as it was. */
  | { kind: 'not-started'; message: string }
  /** The package manager ran and failed, or its result is unknown. */
  | { kind: 'uncertain'; message: string; logPath: string };

/** Written before the package manager starts, removed once its outcome is known. */
export interface ILinuxInstallMarker {
  version: 1;
  packageType: ILinuxPackageType;
  fromVersion: string;
  targetVersion: string;
  file: string;
  logPath: string;
  startedAt: string;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
}

/** The package could not be installed and nothing was changed. */
export class InstallPreconditionError extends Error {
  readonly code = 'UPDATE_PRECONDITION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'InstallPreconditionError';
  }
}

const ARCHITECTURES: Record<string, Record<ILinuxPackageType, string>> = {
  x64: { deb: 'amd64', rpm: 'x86_64' },
  arm64: { deb: 'arm64', rpm: 'aarch64' },
};

/** A marker in a format this version does not know. Its installation is still unresolved. */
function parseMarker(value: unknown): ILinuxInstallMarker | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const marker = value as Record<string, unknown>;
  const isText = (field: unknown) => typeof field === 'string';
  const isNumberOrNull = (field: unknown) => field === null || Number.isInteger(field);
  if (
    marker.version !== 1 ||
    (marker.packageType !== 'deb' && marker.packageType !== 'rpm') ||
    !isText(marker.fromVersion) ||
    !isText(marker.targetVersion) ||
    !isText(marker.file) ||
    !isText(marker.logPath) ||
    !isText(marker.startedAt) ||
    !isNumberOrNull(marker.pid) ||
    !isNumberOrNull(marker.exitCode) ||
    !(marker.signal === null || isText(marker.signal))
  ) {
    return null;
  }
  return marker as unknown as ILinuxInstallMarker;
}

async function sha512Base64(path: string) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('base64');
}

/** The manual command for a package, for recovery guidance. */
export function manualInstallCommand(packageType: ILinuxPackageType, file: string) {
  const quoted = `'${file.replace(/'/g, `'\\''`)}'`;
  return packageType === 'deb' ? `sudo dpkg -i ${quoted}` : `sudo rpm -U ${quoted}`;
}

/**
 * Installs a downloaded DEB or RPM with the system package manager, elevated by
 * pkexec. It runs one fixed command with argument arrays and no shell, and the
 * renderer can neither choose the file nor the command. The installer is
 * detached and writes to a private log, so it finishes even if the app dies; a
 * marker file records that an installation was started.
 */
export function createLinuxInstaller({
  directory,
  currentVersion,
  arch = process.arch,
  log,
  run = promisify(execFile),
  pkexecPath = PKEXEC,
  packageTools = PACKAGE_TOOLS,
}: {
  directory: string;
  currentVersion: string;
  arch?: string;
  log: IFileLog;
  run?: (command: string, args: string[]) => Promise<{ stdout: string }>;
  /** Fixed system paths; tests replace them with fakes. */
  pkexecPath?: string;
  packageTools?: Record<ILinuxPackageType, { install: string; inspect: string }>;
}) {
  const markerPath = libPath.join(directory, MARKER_FILE);
  const logPath = libPath.join(directory, LOG_FILE);
  let isRunning = false;

  const unreadableMarker = (): ILinuxInstallMarker => ({
    version: 1,
    packageType: 'deb',
    fromVersion: 'unknown',
    targetVersion: 'an unknown version',
    file: '',
    logPath,
    startedAt: '',
    pid: null,
    exitCode: null,
    signal: null,
  });

  const writeMarker = (marker: ILinuxInstallMarker) => {
    const temporaryPath = `${markerPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, markerPath);
  };

  /** Checks the package before anything is stopped or elevated. */
  const verify = async (request: ILinuxInstallRequest) => {
    const tools = packageTools[request.packageType];
    for (const tool of [pkexecPath, tools.install, tools.inspect]) {
      if (!existsSync(tool)) {
        throw new InstallPreconditionError(
          `${tool} is not available, so the update cannot be installed automatically. Install it manually: ${manualInstallCommand(request.packageType, request.file)}`
        );
      }
    }
    if ((await sha512Base64(request.file)) !== request.sha512) {
      throw new InstallPreconditionError('The downloaded update does not match its checksum.');
    }
    const fields =
      request.packageType === 'deb'
        ? (
            await run(tools.inspect, [
              '--showformat=${Package}\\n${Version}\\n${Architecture}\\n',
              '--show',
              request.file,
            ])
          ).stdout
        : (
            await run(tools.inspect, [
              '--query',
              '--package',
              '--queryformat',
              '%{NAME}\\n%{VERSION}\\n%{ARCH}\\n',
              request.file,
            ])
          ).stdout;
    const [name, version, packageArch] = fields.trim().split('\n');
    const expectedArch = ARCHITECTURES[arch]?.[request.packageType];
    if (
      name !== LINUX_PACKAGE_NAME ||
      version !== request.version ||
      packageArch !== expectedArch
    ) {
      throw new InstallPreconditionError(
        `The downloaded package is not ${LINUX_PACKAGE_NAME} ${request.version} for ${expectedArch ?? arch}.`
      );
    }
  };

  const commandFor = (request: ILinuxInstallRequest) =>
    request.packageType === 'deb'
      ? // --refuse-downgrade: never replace a newer installed version.
        [packageTools.deb.install, '--refuse-downgrade', '--install', request.file]
      : // rpm refuses downgrades unless told otherwise.
        [packageTools.rpm.install, '--upgrade', request.file];

  return {
    markerPath,
    logPath,

    get isRunning() {
      return isRunning;
    },

    verify,

    /**
     * Runs the package manager. Resolves once it exits. The caller stops the
     * backend first and restores it only for a "not-started" outcome.
     */
    install: (request: ILinuxInstallRequest) =>
      new Promise<ILinuxInstallOutcome>(resolve => {
        const marker: ILinuxInstallMarker = {
          version: 1,
          packageType: request.packageType,
          fromVersion: currentVersion,
          targetVersion: request.version,
          file: request.file,
          logPath,
          startedAt: new Date().toISOString(),
          pid: null,
          exitCode: null,
          signal: null,
        };
        let child: ReturnType<typeof spawn>;
        try {
          writeMarker(marker);
          // Opened before the spawn, so the installer keeps a valid output file
          // even if this process dies.
          const output = openSync(logPath, 'w', 0o600);
          try {
            child = spawn(pkexecPath, commandFor(request), {
              detached: true,
              stdio: ['ignore', output, output],
            });
          } finally {
            closeSync(output);
          }
        } catch (error) {
          // Nothing ran yet, so nothing was changed.
          rmSync(markerPath, { force: true });
          log.error('The update installer could not be prepared', {
            code: (error as NodeJS.ErrnoException).code,
          });
          resolve({ kind: 'not-started', message: 'The system installer could not be started.' });
          return;
        }
        isRunning = true;
        child.unref();
        if (child.pid) {
          try {
            writeMarker({ ...marker, pid: child.pid });
          } catch (error) {
            // The marker without the PID still records the installation.
            log.warn('Unable to record the installer process', { error });
          }
        }
        log.info('Update installation started', {
          packageType: request.packageType,
          version: request.version,
          pid: child.pid,
        });

        child.once('error', error => {
          isRunning = false;
          rmSync(markerPath, { force: true });
          log.error('The update installer could not start', {
            code: (error as NodeJS.ErrnoException).code,
          });
          resolve({ kind: 'not-started', message: 'The system installer could not be started.' });
        });
        child.once('exit', (code, signal) => {
          isRunning = false;
          log.info('Update installation finished', { code, signal });
          if (code === 0) {
            rmSync(markerPath, { force: true });
            resolve({ kind: 'installed' });
          } else if (code !== null && NOT_STARTED_EXIT_CODES.has(code)) {
            rmSync(markerPath, { force: true });
            resolve({
              kind: 'not-started',
              message:
                'The update was not installed: the system authorization was cancelled or is not available.',
            });
          } else {
            // The package manager may have replaced part of the installation.
            try {
              writeMarker({ ...marker, pid: child.pid ?? null, exitCode: code, signal });
            } catch (error) {
              log.warn('Unable to record the installer outcome', { error });
            }
            resolve({
              kind: 'uncertain',
              message: `The system package manager failed (${signal ?? `exit code ${code}`}). The installation may be incomplete.`,
              logPath,
            });
          }
        });
      }),

    /**
     * An installation that was started and whose outcome is not known. A
     * marker that exists but cannot be understood still counts.
     */
    readMarker: (): ILinuxInstallMarker | null => {
      let content: string;
      try {
        content = readFileSync(markerPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;
        }
        return unreadableMarker();
      }
      try {
        return parseMarker(JSON.parse(content)) ?? unreadableMarker();
      } catch {
        return unreadableMarker();
      }
    },

    /** True while the installer recorded in the marker still runs. */
    isMarkerInstallerRunning: (marker: ILinuxInstallMarker) => {
      if (!marker.pid) {
        return false;
      }
      try {
        const command = readFileSync(`/proc/${marker.pid}/cmdline`, 'utf8').split('\0');
        return (
          command.includes(pkexecPath) ||
          command.some(part => part.endsWith('/dpkg') || part.endsWith('/rpm'))
        );
      } catch {
        return false;
      }
    },

    clearMarker: () => rmSync(markerPath, { force: true }),

    /** The end of the installer's output, for recovery guidance. */
    readLogTail: (maxLength = 4_000) => {
      try {
        const content = readFileSync(logPath, 'utf8');
        return content.length > maxLength ? content.slice(-maxLength) : content;
      } catch {
        return '';
      }
    },
  };
}

export type ILinuxInstaller = ReturnType<typeof createLinuxInstaller>;
