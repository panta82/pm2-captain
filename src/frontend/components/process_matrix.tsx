import { useNavigate } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { readPreference, writePreference } from '@/lib/preferences';
import { processLink } from '@/lib/process_route';
import { cn } from '@/lib/utils';
import { type IValueDiff, diffValues } from '@/lib/value_diff';

import type { IProcessSummary } from '@shared/contracts';

import { ErrorPanel } from './error_panel';
import { Button, Skeleton, ToggleGroup } from './ui';

const ONLY_DIFFERENCES_STORAGE_KEY = 'pm2-captain-matrix-only-differences';

export interface IMatrixRow {
  label: string;
  /** One value per process, in column order. `null` means the process lacks it. */
  values: Array<string | null>;
  /** Replaces the plain text of the cells, for values that carry color or icons. */
  cells?: ReactNode[];
}

export interface IMatrixGroup {
  title: string;
  /** Live figures such as CPU always differ, so their groups are not compared. */
  isCompared: boolean;
  rows: IMatrixRow[];
}

/** Several processes side by side: one column each, one row per value. */
export function ProcessMatrix({
  processes,
  groups,
}: {
  processes: IProcessSummary[];
  groups: IMatrixGroup[];
}) {
  const navigate = useNavigate();
  const [showOnlyDifferences, setShowOnlyDifferences] = useState(
    () => readPreference(ONLY_DIFFERENCES_STORAGE_KEY) === 'true'
  );

  const chooseRows = (onlyDifferences: boolean) => {
    setShowOnlyDifferences(onlyDifferences);
    writePreference(ONLY_DIFFERENCES_STORAGE_KEY, String(onlyDifferences));
  };

  const openSelection = (selection: IProcessSummary[]) => {
    void navigate(
      processLink(
        selection[0].daemonId,
        selection.map(process => process.pmId)
      )
    );
  };

  const visibleGroups = groups
    .map(group => ({
      ...group,
      rows: group.rows
        .map(row => {
          const diff: IValueDiff = group.isCompared ? diffValues(row.values) : { isSame: true };
          return { ...row, diff };
        })
        .filter(row => !showOnlyDifferences || !group.isCompared || !row.diff.isSame),
    }))
    .filter(group => group.rows.length);

  return (
    <div data-component="ProcessMatrix" className="flex min-h-0 flex-1 flex-col">
      {/* As tall as the filter row of the side menu, so the two lines meet. */}
      <div className="flex h-detail-toolbar shrink-0 items-center border-b border-line bg-surface-control px-4 sm:px-7">
        <ToggleGroup className="font-sans">
          <Button
            variant="toggle"
            className="h-8 px-3 text-xs"
            aria-pressed={!showOnlyDifferences}
            onClick={() => chooseRows(false)}
          >
            All rows
          </Button>
          <Button
            variant="toggle"
            className="h-8 px-3 text-xs"
            aria-pressed={showOnlyDifferences}
            onClick={() => chooseRows(true)}
          >
            Only differences
          </Button>
        </ToggleGroup>
      </div>
      <div
        // PROCESS_PANE_ATTRIBUTE: Enter in the process list comes here.
        data-process-pane
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan/70"
      >
        {visibleGroups.length ? (
          <table className="w-full border-separate border-spacing-0 font-mono text-[13px]">
            <thead>
              <tr>
                <th className="sticky top-0 left-0 z-30 h-12 w-52 min-w-52 border-r border-b border-line bg-surface-control" />
                {processes.map(process => (
                  <th
                    key={process.pmId}
                    className="sticky top-0 z-20 h-12 max-w-80 min-w-48 border-r border-b border-line bg-surface-control px-4 text-left font-sans text-sm font-semibold"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <i
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          process.status === 'online'
                            ? 'bg-online shadow-[0_0_9px_#35D07F]'
                            : 'border border-muted'
                        )}
                      />
                      <button
                        type="button"
                        className="min-w-0 truncate text-white hover:text-cyan"
                        title={`Open ${process.name}`}
                        onClick={() => openSelection([process])}
                      >
                        {process.name}
                      </button>
                      {process.isCaptain ? (
                        <img
                          src="/pm2-captain-logo-on-dark.png"
                          alt="Captain"
                          title="This is Captain"
                          className="size-3.5 shrink-0 object-contain"
                        />
                      ) : null}
                      <button
                        type="button"
                        className="ml-auto grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-panel-hover hover:text-white"
                        aria-label={`Remove ${process.name} from selection`}
                        onClick={() => openSelection(processes.filter(other => other !== process))}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  </th>
                ))}
                {/* Takes the leftover width, so the process columns keep their size. */}
                <th className="sticky top-0 z-20 w-full border-b border-line bg-surface-control" />
              </tr>
            </thead>
            <tbody>
              {visibleGroups.map(group => (
                <MatrixGroup key={group.title} columnCount={processes.length} group={group} />
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-4 py-10 font-mono text-sm text-muted sm:px-7">
            {showOnlyDifferences
              ? 'No differences. The selected processes share every value.'
              : 'Nothing to compare.'}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Stands in for the table while the details of a selection are incomplete:
 * a skeleton while they load, the reason and a retry once one of them failed.
 */
export function ProcessMatrixError({
  details,
}: {
  details: Array<{
    data?: unknown;
    error: { message: string; data?: { code?: string } | null } | null;
    refetch: () => unknown;
  }>;
}) {
  // A process that is gone leaves the selection by itself; that needs no error.
  const failed = details.filter(
    detail => !detail.data && detail.error && detail.error.data?.code !== 'NOT_FOUND'
  );
  if (!failed.length) {
    return (
      <div data-component="ProcessMatrixError" className="flex-1 overflow-auto p-4 sm:p-7">
        <Skeleton className="h-72" />
      </div>
    );
  }
  return (
    <div data-component="ProcessMatrixError" className="flex min-h-0 flex-1 flex-col">
      <ErrorPanel
        title="Unable to load the selection"
        message={failed[0].error?.message || 'Failed to load the selected processes.'}
      >
        <Button variant="primary" onClick={() => failed.forEach(detail => void detail.refetch())}>
          Try again
        </Button>
      </ErrorPanel>
    </div>
  );
}

function MatrixGroup({
  columnCount,
  group,
}: {
  columnCount: number;
  group: { title: string; rows: Array<IMatrixRow & { diff: IValueDiff }> };
}) {
  return (
    <>
      <tr>
        <td
          colSpan={columnCount + 2}
          className="h-8 border-b border-line/60 bg-panel text-[10px] font-semibold text-muted"
        >
          <span className="sticky left-4 sm:left-7">{group.title}</span>
        </td>
      </tr>
      {group.rows.map(row => (
        <tr key={row.label} data-differs={row.diff.isSame ? undefined : true}>
          <th
            scope="row"
            className="sticky left-0 z-10 h-9 w-52 min-w-52 border-r border-b border-line/60 bg-surface-plane pr-4 pl-4 text-left font-normal break-all text-cyan sm:pl-7"
          >
            {row.diff.isSame ? null : (
              <span className="mr-1.5 text-warning" title="The selected processes differ here">
                ≠
              </span>
            )}
            {row.label}
          </th>
          {row.values.map((value, index) => {
            const isOdd = row.diff.majority !== undefined && value !== row.diff.majority;
            return (
              <td
                key={index}
                data-odd={isOdd || undefined}
                title={value || undefined}
                className={cn(
                  'h-9 max-w-80 min-w-48 truncate border-r border-b border-line/60 px-4',
                  isOdd && 'text-warning shadow-[inset_3px_0_0_var(--color-warning)]',
                  !value && 'text-muted'
                )}
              >
                {row.cells ? row.cells[index] : value === null ? '—' : value || '(empty)'}
              </td>
            );
          })}
          <td className="border-b border-line/60" />
        </tr>
      ))}
    </>
  );
}
