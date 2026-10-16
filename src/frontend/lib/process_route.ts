import { getRouteApi, linkOptions } from '@tanstack/react-router';

import { readPreference, writePreference } from '@/lib/preferences';

const STORAGE_KEY = 'pm2-captain-process-tab';

const PROCESS_TABS = ['info', 'env', 'logs'] as const;

export type ProcessTab = (typeof PROCESS_TABS)[number];

export function isProcessTab(value: string): value is ProcessTab {
  return (PROCESS_TABS as readonly string[]).includes(value);
}

/** The process detail route. Its `pmIds` hold one PM2 ID, or a selection of several. */
export const PROCESS_ROUTE = '/daemons/$daemonId/processes/$pmIds/$tab';

export const processRouteApi = getRouteApi(PROCESS_ROUTE);

export function getProcessTab(): ProcessTab {
  const storedTab = readPreference(STORAGE_KEY);
  return storedTab && isProcessTab(storedTab) ? storedTab : 'info';
}

export function setProcessTab(tab: ProcessTab): void {
  writePreference(STORAGE_KEY, tab);
}

/**
 * Link options for a process, or a selection of them, on the remembered tab.
 * Several processes have no Logs tab, so a selection opens Info instead.
 */
export function processLink(daemonId: string, pmIds: number[], tab: ProcessTab = getProcessTab()) {
  return linkOptions({
    to: PROCESS_ROUTE,
    params: { daemonId, pmIds, tab: pmIds.length > 1 && tab === 'logs' ? 'info' : tab },
  });
}
