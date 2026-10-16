/** IPC channels between the desktop preload and Electron main. Nothing else is exposed. */
export const IPC_CHANNELS = {
  loadPreferences: 'pm2-captain:preferences:load',
  setPreference: 'pm2-captain:preferences:set',
  getUpdateState: 'pm2-captain:updates:get-state',
  checkForUpdates: 'pm2-captain:updates:check',
  installUpdate: 'pm2-captain:updates:install',
  updateState: 'pm2-captain:updates:state',
} as const;
