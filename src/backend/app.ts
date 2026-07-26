#!/usr/bin/env node

import { loadBackendSettings } from './backend_settings';
import { IContainer, createAppContainer } from './container';
import { defaultLog } from './lib/logger';

let container: IContainer;

Promise.resolve()
  .then(main)
  .catch(err => {
    if (container?.logger) {
      container.logger.error({ err }, 'Fatal error!');
    } else {
      defaultLog.error({ err }, 'Fatal error!');
    }
    process.exitCode = 1;
  });

async function main(): Promise<void> {
  const settings = loadBackendSettings();
  container = createAppContainer(settings);

  if (await container.captainLauncher.openExistingIfRunning()) {
    return;
  }

  await container.app.start();
  container.app.attachSignalHandlers();
}
