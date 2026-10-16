import type { IProcessAction, IProcessSummary } from '@shared/contracts';

/**
 * Reads the `$pmIds` route parameter, which holds one PM2 ID or a comma-separated
 * selection of them. Anything else yields an empty list.
 */
export function parsePmIds(param: string): number[] {
  const parts = param.split(',');
  if (!parts.every(part => /^\d+$/.test(part))) {
    return [];
  }
  return [...new Set(parts.map(Number))].sort((left, right) => left - right);
}

/** Writes a selection the way `parsePmIds` returns it, so one selection has one URL. */
export function formatPmIds(pmIds: number[]): string {
  return [...new Set(pmIds)].sort((left, right) => left - right).join(',');
}

/** Ctrl+click: adds the process, or removes it unless it is the only one selected. */
export function toggleSelection(selectedIds: number[], pmId: number): number[] {
  if (!selectedIds.includes(pmId)) {
    return [...selectedIds, pmId];
  }
  return selectedIds.length > 1 ? selectedIds.filter(id => id !== pmId) : selectedIds;
}

/**
 * Shift+click: every listed process from the anchor to the target, both included.
 * A filter can hide the anchor; the range is then the target alone.
 */
export function selectRange(orderedIds: number[], anchorId: number, targetId: number): number[] {
  const anchorIndex = orderedIds.indexOf(anchorId);
  const targetIndex = orderedIds.indexOf(targetId);
  if (anchorIndex < 0 || targetIndex < 0) {
    return [targetId];
  }
  return orderedIds.slice(
    Math.min(anchorIndex, targetIndex),
    Math.max(anchorIndex, targetIndex) + 1
  );
}

/**
 * The processes of a selection that an action applies to, by the rules of the
 * single-process buttons: Start is for what is not running, Restart and Stop are
 * for what is, and Captain may not stop itself.
 */
/**
 * What a confirmation to stop several processes is for: these processes on
 * this connection. A daemon moved to another location can show the same PM2 IDs.
 */
export function stopConfirmationKey(targets: IProcessSummary[]) {
  return targets
    .map(process => `${process.daemonId}:${process.connectionId}:${process.pmId}`)
    .join(',');
}

export function bulkActionTargets<T extends IProcessSummary>(
  action: IProcessAction,
  processes: T[]
): T[] {
  return processes.filter(process => {
    const isOnline = process.status === 'online';
    if (action === 'start') {
      return !isOnline;
    }
    return action === 'restart' ? isOnline : isOnline && !process.isCaptain;
  });
}
