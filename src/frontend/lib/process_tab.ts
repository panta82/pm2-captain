const STORAGE_KEY = 'pm2-captain-process-tab';

export type ProcessTab = 'info' | 'logs';

export function getProcessTab(): ProcessTab {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === 'logs' ? 'logs' : 'info';
  } catch {
    return 'info';
  }
}

export function setProcessTab(tab: ProcessTab): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, tab);
  } catch {
    // ignore quota / private-mode failures
  }
}

export function processDetailTo(
  tab: ProcessTab = getProcessTab()
): '/processes/$pmId/info' | '/processes/$pmId/logs' {
  return tab === 'logs' ? '/processes/$pmId/logs' : '/processes/$pmId/info';
}
