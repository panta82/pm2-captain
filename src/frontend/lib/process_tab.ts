const STORAGE_KEY = 'pm2-captain-process-tab';

export type ProcessTab = 'info' | 'env' | 'logs';

export function getProcessTab(): ProcessTab {
  try {
    const storedTab = localStorage.getItem(STORAGE_KEY);
    return storedTab === 'env' || storedTab === 'logs' ? storedTab : 'info';
  } catch {
    return 'info';
  }
}

export function setProcessTab(tab: ProcessTab): void {
  try {
    localStorage.setItem(STORAGE_KEY, tab);
  } catch {
    // ignore quota / private-mode failures
  }
}

/**
 * The route for a selection of processes. Several processes have no Logs tab,
 * so a remembered Logs tab opens Info for them.
 */
export function selectionDetailTo(selectionSize: number) {
  return processDetailTo(selectionSize > 1 && getProcessTab() === 'logs' ? 'info' : undefined);
}

export function processDetailTo(
  tab: ProcessTab = getProcessTab()
):
  | '/daemons/$daemonId/processes/$pmId/info'
  | '/daemons/$daemonId/processes/$pmId/env'
  | '/daemons/$daemonId/processes/$pmId/logs' {
  if (tab === 'env') {
    return '/daemons/$daemonId/processes/$pmId/env';
  }
  return tab === 'logs'
    ? '/daemons/$daemonId/processes/$pmId/logs'
    : '/daemons/$daemonId/processes/$pmId/info';
}
