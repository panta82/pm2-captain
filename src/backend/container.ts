import { IBackendSettings } from './backend_settings';
import {
  IDIContainer,
  IImporterTupleToServiceImporters,
  createContainer,
  define,
  importer,
} from './framework/dependency_injection';

const loggerImporter = importer('logger', () => import('./lib/logger'));
const logImporter = importer('log', () => import('./lib/logger'), 'logDefinition');
const appImporter = importer('app', () => import('./lib/app'));
const daemonStoreImporter = importer('daemonStore', () => import('./lib/daemon_store'));
const keybindingStoreImporter = importer('keybindingStore', () => import('./lib/keybinding_store'));
const pm2HomeFinderImporter = importer('pm2HomeFinder', () => import('./lib/pm2_home_finder'));
const sshConnectionImporter = importer('sshConnection', () => import('./lib/ssh_connection'));
const pm2ClientImporter = importer('pm2Client', () => import('./lib/pm2_client'));
const logFileReaderImporter = importer('logFileReader', () => import('./lib/log_file_reader'));
const pm2DaemonImporter = importer('pm2Daemon', () => import('./lib/pm2_daemon'));
const processManagerImporter = importer('processManager', () => import('./bl/process_manager'));
const logManagerImporter = importer('logManager', () => import('./bl/log_manager'));
const daemonManagerImporter = importer('daemonManager', () => import('./bl/daemon_manager'));
const appUpdatesImporter = importer('appUpdates', () => import('./bl/app_updates'));
const sessionAuthImporter = importer('sessionAuth', () => import('./web/session_auth'));
const captainLauncherImporter = importer('captainLauncher', () => import('./bl/captain_launcher'));
const webServerImporter = importer('webServer', () => import('./web/web_server'));

// Fake mode: these take the place of the services with the same identifier.
const fakeDaemonStoreImporter = importer('daemonStore', () => import('./fake/fake_daemon_store'));
const fakePm2HomeFinderImporter = importer(
  'pm2HomeFinder',
  () => import('./fake/fake_pm2_home_finder')
);
const fakePm2DaemonImporter = importer('pm2Daemon', () => import('./fake/fake_pm2_daemon'));
const fakeAppUpdatesImporter = importer('appUpdates', () => import('./fake/fake_app_updates'));
// Fake mode only.
const fakeWorldImporter = importer('fakeWorld', () => import('./fake/fake_world'));
const fakeControlImporter = importer('fakeControl', () => import('./fake/fake_control'));

export const SERVICES = [
  loggerImporter,
  logImporter,
  appImporter,
  daemonStoreImporter,
  keybindingStoreImporter,
  pm2HomeFinderImporter,
  sshConnectionImporter,
  pm2ClientImporter,
  logFileReaderImporter,
  pm2DaemonImporter,
  processManagerImporter,
  logManagerImporter,
  daemonManagerImporter,
  appUpdatesImporter,
  sessionAuthImporter,
  captainLauncherImporter,
  webServerImporter,
  fakeWorldImporter,
  fakeControlImporter,
] as const;

export const APP_SERVICES = [
  loggerImporter,
  logImporter,
  appImporter,
  daemonStoreImporter,
  keybindingStoreImporter,
  pm2HomeFinderImporter,
  daemonManagerImporter,
  appUpdatesImporter,
  sessionAuthImporter,
  captainLauncherImporter,
  webServerImporter,
] as const;

export const DAEMON_SERVICES = [
  loggerImporter,
  logImporter,
  appImporter,
  sshConnectionImporter,
  pm2ClientImporter,
  logFileReaderImporter,
  pm2DaemonImporter,
  processManagerImporter,
  logManagerImporter,
] as const;

// The fake lists hold nothing that reaches a real PM2 daemon, SSH or the
// daemon registry on disk. The world comes first: the daemon list is read from it.
export const FAKE_APP_SERVICES = [
  loggerImporter,
  logImporter,
  appImporter,
  fakeWorldImporter,
  fakeDaemonStoreImporter,
  // The user's keys are no simulation: fake mode reads them too.
  keybindingStoreImporter,
  fakePm2HomeFinderImporter,
  daemonManagerImporter,
  fakeAppUpdatesImporter,
  sessionAuthImporter,
  captainLauncherImporter,
  webServerImporter,
  fakeControlImporter,
] as const;

export const FAKE_DAEMON_SERVICES = [
  loggerImporter,
  logImporter,
  appImporter,
  fakePm2DaemonImporter,
  processManagerImporter,
  logManagerImporter,
] as const;

declare module './framework/dependency_injection' {
  type IAppServiceImporters = IImporterTupleToServiceImporters<typeof SERVICES>;
  export interface IServiceImporters extends IAppServiceImporters {}
}

export type IContainer = IDIContainer<IBackendSettings>;
export const createAppContainer = (settings: IBackendSettings) => {
  const services = settings.fake ? FAKE_APP_SERVICES : APP_SERVICES;
  return createContainer<IBackendSettings>(
    settings,
    // The desktop app owns window opening; the browser launch policy, its
    // terminal banner and CLI handoff belong to the npm command only.
    settings.runtime === 'desktop'
      ? services.filter(service => service !== captainLauncherImporter)
      : services
  );
};

export const createDaemonContainer = (settings: IBackendSettings, appContainer: IContainer) => {
  if (!settings.fake) {
    return createContainer<IBackendSettings>(settings, DAEMON_SERVICES);
  }
  const container = createContainer<IBackendSettings>(settings, [
    ...FAKE_DAEMON_SERVICES,
    // The fake world is the one service a daemon container takes from the app
    // container: every fake daemon lives in it.
    {
      identifier: 'fakeWorld' as const,
      require: () => define({ createFakeWorld: () => appContainer.fakeWorld }),
    },
  ]);
  // The app container runs the world's lifecycle. Here only the daemon's own services take part.
  container.app.enroll(...FAKE_DAEMON_SERVICES.map(service => service.identifier));
  return container;
};
