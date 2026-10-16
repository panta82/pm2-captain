// One child process at a time, for `npm run desktop:dev`: restart() replaces
// it, stop() ends it for good. Stopping a child is always bounded: SIGTERM,
// then SIGKILL once the limit passes, so a child that ignores SIGTERM can hold
// up neither a restart nor Ctrl+C.

/**
 * `start` spawns the child. `onExit(code, signal)` runs when a child exits that
 * was not being stopped. Restarts run one at a time; after stop() none starts.
 */
export function createRestartableProcess({ start, stopLimitMs, onExit }) {
  let child = null;
  let isStopped = false;
  let restarts = Promise.resolve();
  // One stop per child, shared by a restart and a shutdown that overlap.
  const stops = new Map();

  const stopChild = target => {
    if (target.exitCode !== null || target.signalCode !== null) {
      return Promise.resolve();
    }
    let stopped = stops.get(target);
    if (!stopped) {
      stopped = new Promise(resolve => {
        const killTimer = setTimeout(() => target.kill('SIGKILL'), stopLimitMs);
        target.once('exit', () => {
          clearTimeout(killTimer);
          stops.delete(target);
          resolve();
        });
      });
      stops.set(target, stopped);
      target.kill('SIGTERM');
    }
    return stopped;
  };

  const replace = async () => {
    if (child) {
      await stopChild(child);
    }
    if (isStopped) {
      return;
    }
    const next = start();
    child = next;
    // Registered before any stop's listener, so stops.has() tells the cases apart.
    next.once('exit', (code, signal) => {
      if (child === next) {
        child = null;
      }
      if (!stops.has(next) && !isStopped) {
        onExit(code, signal);
      }
    });
  };

  return {
    restart: () => {
      restarts = restarts.then(replace);
      return restarts;
    },

    // A restart under way shares the stop of its old child and then starts
    // nothing, so both end within the limit.
    stop: async () => {
      isStopped = true;
      await Promise.all([child ? stopChild(child) : null, restarts]);
    },
  };
}
