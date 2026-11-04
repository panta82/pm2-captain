import { createContext, useContext, useMemo } from 'react';

import { buildHighlightRegex, escapeRegExp } from '@/lib/highlight';

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

/**
 * The expression a process filter searches with, or null without one. Plain text
 * is lax: its words are found in order with anything between them, so "aup dev"
 * finds "aup-backend-dev". An expression is taken as it is.
 */
export function buildProcessSearchRegex(
  search: string,
  options: { caseSensitive: boolean; regex: boolean }
): RegExp | null {
  const pattern = options.regex ? search : search.trim().split(/\s+/).map(escapeRegExp).join('.*?');
  return pattern ? buildHighlightRegex(pattern, { ...options, regex: true }) : null;
}

/**
 * Whether the filter finds a process. Each field is searched on its own, as each
 * is highlighted on its own: one joined string would let a search such as "work "
 * match across two fields, and keep a row with nothing to highlight.
 */
export function matchesProcess(process: IProcessSummary, regex: RegExp): boolean {
  return [
    String(process.pmId),
    process.name,
    process.namespace,
    process.status,
    process.mode,
    process.pid == null ? '' : String(process.pid),
    process.version || '',
  ].some(field => {
    // A global expression continues from its last match.
    regex.lastIndex = 0;
    return regex.test(field);
  });
}

/** Applies the shared filter. `highlight` paints the matches in the kept rows. */
export function useFilteredProcesses(processes: IProcessSummary[]) {
  const { search, caseSensitive, regex } = useProcessListFilter();

  return useMemo(() => {
    try {
      const highlight = buildProcessSearchRegex(search, { caseSensitive, regex });
      if (!highlight) {
        return { processes, error: '', highlight: null };
      }
      return {
        processes: processes.filter(process => matchesProcess(process, highlight)),
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
