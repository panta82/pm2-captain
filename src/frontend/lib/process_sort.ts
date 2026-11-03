import type { IProcessSummary } from '@shared/contracts';

export const PROCESS_SORT_KEYS = [
  'name',
  'status',
  'id',
  'namespace',
  'mode',
  'restarts',
  'cpu',
  'memory',
  'uptime',
  'pid',
  'version',
] as const;

export type IProcessSortKey = (typeof PROCESS_SORT_KEYS)[number];

/** How the processes inside each daemon are ordered. Null keeps PM2's order. */
export interface IProcessSort {
  key: IProcessSortKey;
  isDescending: boolean;
}

/** Empty values have no place in a ranking, so they stay last in both directions. */
const SORT_VALUES: Record<IProcessSortKey, (process: IProcessSummary) => string | number | null> = {
  name: process => process.name,
  status: process => (process.status === 'online' ? 0 : 1),
  id: process => process.pmId,
  namespace: process => process.namespace,
  mode: process => process.mode,
  restarts: process => process.restarts,
  cpu: process => process.cpu,
  memory: process => process.memory,
  uptime: process => process.uptime,
  pid: process => process.pid,
  version: process => process.version,
};

/** Numbers start with the highest, except the ID and status, which read top down. */
const DESCENDING_FIRST: ReadonlySet<IProcessSortKey> = new Set([
  'restarts',
  'cpu',
  'memory',
  'uptime',
  'pid',
]);

// One collator for all comparisons: a sort makes many, on every poll.
const TEXT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareProcesses(sort: IProcessSort, left: IProcessSummary, right: IProcessSummary) {
  const read = SORT_VALUES[sort.key];
  const leftValue = read(left);
  const rightValue = read(right);
  const isLeftEmpty = leftValue === null || leftValue === '';
  const isRightEmpty = rightValue === null || rightValue === '';
  if (isLeftEmpty || isRightEmpty) {
    return Number(isLeftEmpty) - Number(isRightEmpty) || left.pmId - right.pmId;
  }
  const result =
    typeof leftValue === 'string' || typeof rightValue === 'string'
      ? TEXT_COLLATOR.compare(String(leftValue), String(rightValue))
      : leftValue - rightValue;
  return (sort.isDescending ? -result : result) || left.pmId - right.pmId;
}

export function sortProcesses(
  processes: IProcessSummary[],
  sort: IProcessSort | null
): IProcessSummary[] {
  return sort
    ? [...processes].sort((left, right) => compareProcesses(sort, left, right))
    : processes;
}

/** A column header: the column's natural direction, the other one, then PM2's order again. */
export function cycleProcessSort(
  current: IProcessSort | null,
  key: IProcessSortKey
): IProcessSort | null {
  const isDescendingFirst = DESCENDING_FIRST.has(key);
  if (current?.key !== key) {
    return { key, isDescending: isDescendingFirst };
  }
  return current.isDescending === isDescendingFirst
    ? { key, isDescending: !isDescendingFirst }
    : null;
}

/** The sort menu: another key starts in its natural direction, the same key flips it. */
export function chooseProcessSort(
  current: IProcessSort | null,
  key: IProcessSortKey
): IProcessSort {
  return current?.key === key
    ? { key, isDescending: !current.isDescending }
    : { key, isDescending: DESCENDING_FIRST.has(key) };
}

/** Written to the preferences as `key:asc` or `key:desc`, and empty for PM2's order. */
export function formatProcessSort(sort: IProcessSort | null): string {
  return sort ? `${sort.key}:${sort.isDescending ? 'desc' : 'asc'}` : '';
}

export function parseProcessSort(value: string | null): IProcessSort | null {
  const [key, direction] = (value ?? '').split(':');
  if (
    !(PROCESS_SORT_KEYS as readonly string[]).includes(key) ||
    (direction !== 'asc' && direction !== 'desc')
  ) {
    return null;
  }
  return { key: key as IProcessSortKey, isDescending: direction === 'desc' };
}
