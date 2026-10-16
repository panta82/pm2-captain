// The backend the desktop app owns, run by Electron's utility process. It
// speaks to Electron main only through process.parentPort; everything else is
// the shared backend.
import { createDesktopBackendSettings } from '../../backend/backend_settings';
import { IContainer, createAppContainer } from '../../backend/container';
import { DaemonRegistryError } from '../../backend/lib/daemon_store';
import { listOwnedProcessIds, onOwnedProcessesChange } from '../../backend/lib/owned_processes';
import { loadPm2Api } from '../../backend/lib/pm2_client';
import { IBackendMessage, IBackendRequest, IBackendStartupError } from '../shared/backend_protocol';

/** How often the backend checks that the app that started it still exists. */
const PARENT_CHECK_INTERVAL_MS = 1_000;
/** The longest a shutdown may take before the process exits anyway. */
const SHUTDOWN_LIMIT_MS = 8_000;

const parentPort = process.parentPort;
const initialParentPid = process.ppid;
let container: IContainer | null = null;
let runId: string | null = null;
let shutdownPromise: Promise<void> | null = null;

const post = (message: IBackendMessage) => {
  parentPort.postMessage(message);
};

const describeStartupError = (error: unknown): IBackendStartupError => {
  if (error instanceof DaemonRegistryError) {
    return { code: 'REGISTRY_INVALID', message: error.message, path: error.path };
  }
  return {
    code: 'STARTUP_FAILED',
    message: error instanceof Error ? error.message : 'The backend failed to start.',
    path: null,
  };
};

const shutdown = (exitCode: number) => {
  shutdownPromise ??= (async () => {
    const limit = setTimeout(() => process.exit(exitCode || 1), SHUTDOWN_LIMIT_MS);
    try {
      await container?.app.dispose();
    } catch (error) {
      container?.logger.error({ error }, 'Desktop backend shutdown failed');
    }
    clearTimeout(limit);
    if (runId) {
      post({ type: 'stopped', runId });
    }
    process.exit(exitCode);
  })();
  return shutdownPromise;
};

const start = async (request: Extract<IBackendRequest, { type: 'start' }>) => {
  if (container) {
    return;
  }
  runId = request.runId;
  try {
    // The PM2 API class is otherwise loaded only once a daemon connects. Loading
    // it here proves that the packaged app can import it from its archive,
    // without creating anything in a PM2 home.
    try {
      await loadPm2Api();
    } catch {
      throw new Error('The bundled PM2 library could not be loaded. Reinstall PM2 Captain.');
    }
    container = createAppContainer(createDesktopBackendSettings(request.options));
    await container.app.start();
    post({
      type: 'ready',
      runId: request.runId,
      baseURL: container.webServer.baseURL,
      launchToken: await container.sessionAuth.ensureToken(),
    });
    // Fake mode: the app shows and acts on the simulated update of this world.
    if (container.settings.fake) {
      const updates = container.fakeWorld.updates;
      updates.onChange(state => post({ type: 'fake-update', state }));
      post({ type: 'fake-update', state: updates.state });
    }
  } catch (error) {
    post({ type: 'failed', runId: request.runId, error: describeStartupError(error) });
    await shutdown(1);
  }
};

parentPort.on('message', event => {
  const request = event.data as IBackendRequest;
  if (request?.type === 'start') {
    void start(request);
  } else if (request?.type === 'stop' && request.runId === runId) {
    void shutdown(0);
  } else if (request?.type === 'fake-update-action' && container?.settings.fake) {
    const updates = container.fakeWorld.updates;
    if (request.action === 'install') {
      updates.install();
    } else if (request.action === 'check') {
      updates.check();
    }
  }
});

// The app may end this process with a signal, for example when a stop takes too long.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(0));
}

// If the app dies without stopping this process, the process is handed to
// another parent. It then shuts down, ending its SSH children with it.
setInterval(() => {
  if (process.ppid !== initialParentPid) {
    void shutdown(0);
  }
}, PARENT_CHECK_INTERVAL_MS).unref();

// The app ends whatever is left of these if this process dies abruptly.
onOwnedProcessesChange(() => post({ type: 'owned-processes', pids: listOwnedProcessIds() }));
