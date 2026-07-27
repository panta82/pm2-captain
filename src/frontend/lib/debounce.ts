import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

export type IDebouncePhase = 'idle' | 'debouncing' | 'resolving';

/**
 * Debounced string for search/filter UIs.
 * - idle: draft matches committed value
 * - debouncing: waiting for quiet period after typing
 * - resolving: applying the committed value (including React transition work)
 * Empty draft commits immediately (no debounce), matching AuthoredUp DebouncingTextBox.
 */
export function useDebouncedSearch(delayMs = 300): {
  draft: string;
  value: string;
  phase: IDebouncePhase;
  setDraft: (next: string) => void;
} {
  const [draft, setDraftState] = useState('');
  const [value, setValue] = useState('');
  const [phase, setPhase] = useState<IDebouncePhase>('idle');
  const [isPending, startTransition] = useTransition();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = useCallback((next: string) => {
    setPhase('resolving');
    startTransition(() => {
      setValue(next);
    });
  }, []);

  useEffect(() => {
    if (!isPending && draft === value) {
      setPhase('idle');
    }
  }, [draft, isPending, value]);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    []
  );

  const setDraft = useCallback(
    (next: string) => {
      setDraftState(next);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (!next) {
        commit('');
        return;
      }
      setPhase('debouncing');
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        commit(next);
      }, delayMs);
    },
    [commit, delayMs]
  );

  return {
    draft,
    value,
    phase: isPending ? 'resolving' : phase,
    setDraft,
  };
}
