import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';

import type { IDebouncePhase } from '@/lib/debounce';
import { type ILogSearchTerm, SEARCH_COLORS, addSearchTerm } from '@/lib/highlight';

const SEARCH_DEBOUNCE_MS = 300; // quiet period before a box applies

/** The first box filters, in the filter green, as the single filter always did. */
const INITIAL_TERMS: ILogSearchTerm[] = [
  { id: 1, search: '', isCaseSensitive: false, isRegex: false, isFilter: true, color: 'green' },
];

/** One box per color. */
export const MAX_SEARCH_TERMS = SEARCH_COLORS.length;

type ITermPatch = Partial<Omit<ILogSearchTerm, 'id'>>;

/** The boxes of one process: what the logs use, and what each box shows while typing. */
type ILogSearchScope = {
  terms: ILogSearchTerm[];
  drafts: ReadonlyMap<number, string>;
};

const EMPTY_SCOPE: ILogSearchScope = { terms: INITIAL_TERMS, drafts: new Map() };

type ILogSearchStore = {
  scopes: ReadonlyMap<string, ILogSearchScope>;
  isPending: boolean;
  setDraft: (scope: string, id: number, draft: string) => void;
  updateTerm: (scope: string, id: number, patch: ITermPatch) => void;
  addTerm: (scope: string) => void;
  removeTerm: (scope: string, id: number) => void;
};

/**
 * The boxes of the log search for one process. `terms` holds what the logs use
 * and only changes when a box commits; a box's text changes on every keystroke
 * and commits after a quiet period. An empty box commits at once.
 */
export type ILogSearch = {
  terms: ILogSearchTerm[];
  getDraft: (term: ILogSearchTerm) => string;
  getPhase: (term: ILogSearchTerm) => IDebouncePhase;
  setDraft: (id: number, draft: string) => void;
  updateTerm: (id: number, patch: ITermPatch) => void;
  addTerm: () => void;
  removeTerm: (id: number) => void;
};

const LogSearchContext = createContext<ILogSearchStore | null>(null);

/**
 * Keeps every process's boxes for the whole app, so they stay as tabs and
 * processes change, and each process comes back to its own.
 */
export function LogSearchProvider({ children }: { children: ReactNode }) {
  const [scopes, setScopes] = useState<ReadonlyMap<string, ILogSearchScope>>(new Map());
  const [isPending, startTransition] = useTransition();
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = timersRef.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  const updateScope = useCallback(
    (scope: string, update: (current: ILogSearchScope) => ILogSearchScope) => {
      setScopes(current => new Map(current).set(scope, update(current.get(scope) ?? EMPTY_SCOPE)));
    },
    []
  );

  const updateTerm = useCallback(
    (scope: string, id: number, patch: ITermPatch) => {
      updateScope(scope, current => ({
        ...current,
        terms: current.terms.map(term => (term.id === id ? { ...term, ...patch } : term)),
      }));
    },
    [updateScope]
  );

  const setDraft = useCallback(
    (scope: string, id: number, draft: string) => {
      updateScope(scope, current => ({
        ...current,
        drafts: new Map(current.drafts).set(id, draft),
      }));
      const timers = timersRef.current;
      const timerKey = `${scope}#${id}`;
      clearTimeout(timers.get(timerKey));
      const commit = () => {
        timers.delete(timerKey);
        startTransition(() => updateTerm(scope, id, { search: draft }));
      };
      if (draft) {
        timers.set(timerKey, setTimeout(commit, SEARCH_DEBOUNCE_MS));
      } else {
        commit();
      }
    },
    [updateScope, updateTerm]
  );

  const addTerm = useCallback(
    (scope: string) => {
      updateScope(scope, current =>
        current.terms.length < MAX_SEARCH_TERMS
          ? { ...current, terms: addSearchTerm(current.terms) }
          : current
      );
    },
    [updateScope]
  );

  const removeTerm = useCallback(
    (scope: string, id: number) => {
      const timers = timersRef.current;
      clearTimeout(timers.get(`${scope}#${id}`));
      timers.delete(`${scope}#${id}`);
      updateScope(scope, current => {
        const drafts = new Map(current.drafts);
        drafts.delete(id);
        return { terms: current.terms.filter(term => term.id !== id), drafts };
      });
    },
    [updateScope]
  );

  const store = useMemo<ILogSearchStore>(
    () => ({ scopes, isPending, setDraft, updateTerm, addTerm, removeTerm }),
    [addTerm, isPending, removeTerm, scopes, setDraft, updateTerm]
  );

  return <LogSearchContext.Provider value={store}>{children}</LogSearchContext.Provider>;
}

/** The boxes of one process, identified like every log call: daemon and PM2 ID. */
export function useLogSearch(daemonId: string, pmId: number): ILogSearch {
  const store = useContext(LogSearchContext);
  if (!store) {
    throw new Error('useLogSearch needs a LogSearchProvider.');
  }
  const scope = `${daemonId}:${pmId}`;
  const { terms, drafts } = store.scopes.get(scope) ?? EMPTY_SCOPE;
  const { isPending, setDraft, updateTerm, addTerm, removeTerm } = store;

  return useMemo<ILogSearch>(() => {
    const getDraft = (term: ILogSearchTerm) => drafts.get(term.id) ?? term.search;
    return {
      terms,
      getDraft,
      getPhase: term =>
        getDraft(term) === term.search ? 'idle' : isPending ? 'resolving' : 'debouncing',
      setDraft: (id, draft) => setDraft(scope, id, draft),
      updateTerm: (id, patch) => updateTerm(scope, id, patch),
      addTerm: () => addTerm(scope),
      removeTerm: id => removeTerm(scope, id),
    };
  }, [addTerm, drafts, isPending, removeTerm, scope, setDraft, terms, updateTerm]);
}
