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

export function processDetailTo(
  tab: ProcessTab = getProcessTab()
): '/processes/$pmId/info' | '/processes/$pmId/env' | '/processes/$pmId/logs' {
  if (tab === 'env') {
    return '/processes/$pmId/env';
  }
  return tab === 'logs' ? '/processes/$pmId/logs' : '/processes/$pmId/info';
}
