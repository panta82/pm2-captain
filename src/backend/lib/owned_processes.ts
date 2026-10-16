import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

const ownedProcessIds = new Set<number>();
const events = new EventEmitter();

/**
 * Records a child process this Captain started and is responsible for ending.
 * A supervisor that outlives Captain, such as the desktop app, can read the
 * list and end what is left if Captain itself is killed.
 */
export function trackOwnedProcess(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  ownedProcessIds.add(pid);
  events.emit('change');
  child.once('exit', () => {
    ownedProcessIds.delete(pid);
    events.emit('change');
  });
}

export function listOwnedProcessIds() {
  return Array.from(ownedProcessIds);
}

export function onOwnedProcessesChange(listener: () => void) {
  events.on('change', listener);
  return () => {
    events.off('change', listener);
  };
}
