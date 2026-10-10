import { createContext, useContext, useMemo } from 'react';

import { buildHighlightRegex } from '@/lib/highlight';

import type { IProcessSummary } from '@shared/contracts';

/**
 * Filter shared by every process list. It applies on every keystroke: a PM2
 * process list is small enough that debouncing would only add lag.
 */
export type IProcessListFilter = {
  search: string;
  caseSensitive: boolean;
  regex: boolean;
  setSearch: (next: string) => void;
  setCaseSensitive: (next: boolean) => void;
  setRegex: (next: boolean) => void;
};

const ProcessListFilterContext = createContext<IProcessListFilter>({
  search: '',
  caseSensitive: false,
  regex: false,
  setSearch: () => undefined,
  setCaseSensitive: () => undefined,
  setRegex: () => undefined,
});

export function ProcessListFilterProvider({
  value,
  children,
}: {
  value: IProcessListFilter;
  children: React.ReactNode;
}) {
  return (
    <ProcessListFilterContext.Provider value={value}>{children}</ProcessListFilterContext.Provider>
  );
}

export function useProcessListFilter(): IProcessListFilter {
  return useContext(ProcessListFilterContext);
}

function processSearchHaystack(process: IProcessSummary): string {
  return [
    String(process.pmId),
    process.name,
    process.namespace,
    process.status,
    process.mode,
    process.pid == null ? '' : String(process.pid),
    process.version || '',
  ].join(' ');
}

/** Applies the shared filter. `highlight` paints the matches in the kept rows. */
export function useFilteredProcesses(processes: IProcessSummary[]) {
  const { search, caseSensitive, regex } = useProcessListFilter();

  return useMemo(() => {
    if (!search) {
      return { processes, error: '', highlight: null as RegExp | null };
    }

    try {
      const highlight = buildHighlightRegex(search, { caseSensitive, regex });
      return {
        processes: processes.filter(process => {
          highlight.lastIndex = 0;
          return highlight.test(processSearchHaystack(process));
        }),
        highlight,
        error: '',
      };
    } catch (error) {
      return {
        processes: [],
        highlight: null as RegExp | null,
        error: error instanceof Error ? error.message : 'Invalid regular expression',
      };
    }
  }, [caseSensitive, regex, search, processes]);
}
