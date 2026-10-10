import { IBackendSettings } from './backend_settings';
import {
  IDIContainer,
  IImporterTupleToServiceImporters,
  createContainer,
  importer,
} from './framework/dependency_injection';

const loggerImporter = importer('logger', () => import('./lib/logger'));
const logImporter = importer('log', () => import('./lib/logger'), 'logDefinition');
const appImporter = importer('app', () => import('./lib/app'));
const daemonStoreImporter = importer('daemonStore', () => import('./lib/daemon_store'));
const pm2HomeFinderImporter = importer('pm2HomeFinder', () => import('./lib/pm2_home_finder'));
const sshConnectionImporter = importer('sshConnection', () => import('./lib/ssh_connection'));
const pm2ClientImporter = importer('pm2Client', () => import('./lib/pm2_client'));
const logFileReaderImporter = importer('logFileReader', () => import('./lib/log_file_reader'));
const processManagerImporter = importer('processManager', () => import('./bl/process_manager'));
const logManagerImporter = importer('logManager', () => import('./bl/log_manager'));
const daemonManagerImporter = importer('daemonManager', () => import('./bl/daemon_manager'));
const captainLauncherImporter = importer('captainLauncher', () => import('./bl/captain_launcher'));
const webServerImporter = importer('webServer', () => import('./web/web_server'));

export const SERVICES = [
  loggerImporter,
  logImporter,
  appImporter,
  daemonStoreImporter,
  pm2HomeFinderImporter,
  sshConnectionImporter,
  pm2ClientImporter,
  logFileReaderImporter,
  processManagerImporter,
  logManagerImporter,
  daemonManagerImporter,
  captainLauncherImporter,
  webServerImporter,
] as const;

export const APP_SERVICES = [
  loggerImporter,
  logImporter,
  appImporter,
  daemonStoreImporter,
  pm2HomeFinderImporter,
  daemonManagerImporter,
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
  processManagerImporter,
  logManagerImporter,
] as const;

declare module './framework/dependency_injection' {
  type IAppServiceImporters = IImporterTupleToServiceImporters<typeof SERVICES>;
  export interface IServiceImporters extends IAppServiceImporters {}
}

export type IContainer = IDIContainer<IBackendSettings>;
export const createAppContainer = (settings: IBackendSettings, services = APP_SERVICES) => {
  return createContainer<IBackendSettings>(settings, services);
};

export const createDaemonContainer = (settings: IBackendSettings) => {
  return createContainer<IBackendSettings>(settings, DAEMON_SERVICES);
};
