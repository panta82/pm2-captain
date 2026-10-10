import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';

import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';

// PM2 titles its daemon process "PM2 v<version>: God Daemon (<PM2_HOME>)".
const DAEMON_TITLE_PATTERN = /^PM2 v\S+: God Daemon \((\/.*)\)$/;

// Importing the pm2 package creates logs/, pids/ and modules/ in a PM2 home,
// so those alone do not prove a daemon ever ran there. These files do.
const DAEMON_MARKERS = ['rpc.sock', 'pm2.log'];

/** Reads PM2 homes from `ps -A -o uid=,args=` output, keeping daemons run by `uid`. */
export function parseDaemonHomes(output: string, uid: number | null): string[] {
  const homes: string[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
    if (!match || (uid !== null && Number(match[1]) !== uid)) {
      continue;
    }
    const home = DAEMON_TITLE_PATTERN.exec(match[2])?.[1];
    if (home) {
      homes.push(home);
    }
  }
  return homes;
}

export function createPm2HomeFinder({ settings, log }: IContainer) {
  // Another user's daemon socket is not accessible, so only this user's count.
  const listDaemonHomes = () =>
    new Promise<string[]>(resolve => {
      execFile(
        'ps',
        ['-A', '-o', 'uid=,args='],
        { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            log.debug({ error }, 'Unable to list running PM2 daemons');
            resolve([]);
            return;
          }
          resolve(parseDaemonHomes(stdout, process.getuid?.() ?? null));
        }
      );
    });

  const hasDaemonMarker = async (home: string) => {
    for (const marker of DAEMON_MARKERS) {
      try {
        await fs.access(libPath.join(home, marker));
        return true;
      } catch {
        // Try the next marker.
      }
    }
    return false;
  };

  return new (class Pm2HomeFinder {
    /**
     * Finds PM2 homes on this computer: running daemons, PM2_HOME and ~/.pm2.
     * A stopped PM2 counts if a daemon has run in its home before.
     */
    find = async (): Promise<string[]> => {
      const candidates = [
        libPath.join(libOs.homedir(), '.pm2'),
        ...(settings.environmentPm2Home ? [libPath.resolve(settings.environmentPm2Home)] : []),
        ...(await listDaemonHomes()),
      ];
      const homes = new Set<string>();
      for (const candidate of candidates) {
        let home: string;
        try {
          home = await fs.realpath(candidate);
        } catch {
          continue;
        }
        if (!homes.has(home) && (await hasDaemonMarker(home))) {
          homes.add(home);
        }
      }
      log.debug({ count: homes.size }, 'Detected local PM2 homes');
      return Array.from(homes);
    };
  })();
}

export default define({
  createPm2HomeFinder,
});
