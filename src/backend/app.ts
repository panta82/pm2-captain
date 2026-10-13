#!/usr/bin/env node
import { loadBackendSettings } from './backend_settings';
import { PORT_CONFLICT_EXIT_CODE, PortConflictError } from './bl/captain_launcher';
import { IContainer, createAppContainer } from './container';
import { runFakeCommandLine } from './fake/fake_cli';

let container: IContainer;

Promise.resolve()
  .then(main)
  .catch(err => {
    if (container?.settings.debug) {
      container.logger.error({ err }, 'Fatal error!');
    } else {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
      console.error(`
PM2 Captain failed to start.

  ${message}
`);
    }
    process.exitCode = err instanceof PortConflictError ? PORT_CONFLICT_EXIT_CODE : 1;
  });

async function main(): Promise<void> {
  const settings = loadBackendSettings();
  container = createAppContainer(settings);

  if (settings.fakeCommand) {
    await runFakeCommandLine(container, settings.fakeCommand);
    return;
  }

  if (await container.captainLauncher.openExistingIfRunning()) {
    return;
  }

  await container.app.start();
  container.app.attachSignalHandlers();
}
