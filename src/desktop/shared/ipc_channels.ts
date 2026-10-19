/** IPC channels between the desktop preload and Electron main. Nothing else is exposed. */
export const IPC_CHANNELS = {
  loadPreferences: 'pm2-captain:preferences:load',
  setPreference: 'pm2-captain:preferences:set',
  getUpdateState: 'pm2-captain:updates:get-state',
  checkForUpdates: 'pm2-captain:updates:check',
  installUpdate: 'pm2-captain:updates:install',
  skipUpdate: 'pm2-captain:updates:skip',
  updateState: 'pm2-captain:updates:state',
  openFindBar: 'pm2-captain:find:open',
  stepFindBar: 'pm2-captain:find:step',
  findBarState: 'pm2-captain:find:state',
  findBarBack: 'pm2-captain:find:back',
} as const;

/**
 * IPC between the find bar's own view and Electron main. Main listens on that
 * view's web contents only, so the Captain page cannot send these.
 */
export const FIND_BAR_CHANNELS = {
  /** Bar to main: find the text, starting a new search or stepping through the current one. */
  find: 'pm2-captain:find-bar:find',
  /** Bar to main: the text was cleared. */
  stop: 'pm2-captain:find-bar:stop',
  /** Bar to main: close the bar. */
  close: 'pm2-captain:find-bar:close',
  /** Bar to main: back to the page's filter boxes, leaving the bar open. */
  back: 'pm2-captain:find-bar:back',
  /** Main to bar: the bar was opened or focused. */
  show: 'pm2-captain:find-bar:show',
  /** Main to bar: matches found in the page. */
  result: 'pm2-captain:find-bar:result',
} as const;

/** Sent with FIND_BAR_CHANNELS.show. */
export interface IFindBarShow {
  /** The bar was hidden until now. */
  isReopened: boolean;
  /** Step to the next (true) or previous (false) match, or only focus the bar (null). */
  step: boolean | null;
}

/** Sent with FIND_BAR_CHANNELS.result. */
export interface IFindBarResult {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
}
