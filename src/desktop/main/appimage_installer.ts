import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import libPath from 'node:path';

import type { IFileLog } from './desktop_log';

export interface IAppImageInstallRequest {
  /** The AppImage that is running, from $APPIMAGE. */
  appImagePath: string;
  /** The downloaded new version. */
  file: string;
  /** Base64 SHA-512 from the update manifest. */
  sha512: string;
}

export type IAppImageInstallOutcome =
  { kind: 'installed' } | { kind: 'not-started'; message: string };

async function sha512Base64(path: string) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('base64');
}

/**
 * Replaces the running AppImage with the downloaded one. electron-updater
 * 6.8.9 (out/AppImageUpdater.js, doInstall) deletes the old file before it
 * moves the new one into place, so a failed move leaves no app at all. Here the
 * new file is copied next to the old one, checked and synced, then renamed
 * over it: a rename within one directory replaces the file atomically
 * (rename(2)), so the AppImage is always either the old or the new version.
 * The running app keeps using the old file's data until it exits.
 */
export async function installAppImage(
  request: IAppImageInstallRequest,
  log: IFileLog
): Promise<IAppImageInstallOutcome> {
  const { appImagePath, file, sha512 } = request;
  if (!libPath.isAbsolute(appImagePath) || appImagePath.includes('\0')) {
    return { kind: 'not-started', message: 'The location of this AppImage is not known.' };
  }
  const temporaryPath = libPath.join(
    libPath.dirname(appImagePath),
    `.${libPath.basename(appImagePath)}.update-${randomUUID()}`
  );
  try {
    if (!(await fs.stat(appImagePath)).isFile()) {
      return { kind: 'not-started', message: 'The running AppImage is not a regular file.' };
    }
    await fs.copyFile(file, temporaryPath);
    if ((await sha512Base64(temporaryPath)) !== sha512) {
      throw new Error('The copied update does not match its checksum.');
    }
    await fs.chmod(temporaryPath, 0o755);
    const handle = await fs.open(temporaryPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, appImagePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    log.warn('The AppImage could not be replaced', { error });
    return {
      kind: 'not-started',
      message: `The update could not replace ${appImagePath}. Check that its folder is writable, or download the new version from the releases page.`,
    };
  }
  log.info('AppImage replaced', { appImagePath });
  return { kind: 'installed' };
}
