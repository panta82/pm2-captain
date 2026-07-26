import { IBackendSettings } from './backend_settings';
import {
  IDIContainer,
  IImporterTupleToServiceImporters,
  createContainer,
  importer,
} from './framework/dependency_injection';

export const SERVICES = [
  importer('logger', () => import('./lib/logger')),
  importer('log', () => import('./lib/logger'), 'logDefinition'),
  importer('app', () => import('./lib/app')),

  importer('pm2Client', () => import('./lib/pm2_client')),
  importer('logFileReader', () => import('./lib/log_file_reader')),

  importer('processManager', () => import('./bl/process_manager')),
  importer('logManager', () => import('./bl/log_manager')),
  importer('captainLauncher', () => import('./bl/captain_launcher')),

  importer('webServer', () => import('./web/web_server')),
] as const;

declare module './framework/dependency_injection' {
  type IAppServiceImporters = IImporterTupleToServiceImporters<typeof SERVICES>;
  export interface IServiceImporters extends IAppServiceImporters {}
}

export type IContainer = IDIContainer<IBackendSettings>;
export const createAppContainer = (settings: IBackendSettings, services = SERVICES) => {
  return createContainer<IBackendSettings>(settings, services);
};
