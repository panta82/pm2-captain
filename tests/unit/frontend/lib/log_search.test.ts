// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { type ReactNode, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LogSearchProvider,
  MAX_SEARCH_TERMS,
  useLogSearch,
} from '../../../../src/frontend/lib/log_search';

/** The boxes of two processes, from one provider, as the page sees them. */
function renderLogSearch() {
  return renderHook(() => ({ api: useLogSearch('local', 0), worker: useLogSearch('local', 1) }), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(LogSearchProvider, null, children),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLogSearch', () => {
  it('commits a box after a quiet period, and restarts the wait on every keystroke', () => {
    const { result } = renderLogSearch();
    const box = () => result.current.api.terms[0];

    act(() => result.current.api.setDraft(box().id, 'err'));
    act(() => vi.advanceTimersByTime(200));
    act(() => result.current.api.setDraft(box().id, 'error'));
    act(() => vi.advanceTimersByTime(200));
    expect(box().search).toBe('');
    expect(result.current.api.getDraft(box())).toBe('error');
    expect(result.current.api.getPhase(box())).toBe('debouncing');

    act(() => vi.advanceTimersByTime(100));
    expect(box().search).toBe('error');
    expect(result.current.api.getPhase(box())).toBe('idle');
  });

  it('commits an emptied box at once, and drops the text that was still waiting', () => {
    const { result } = renderLogSearch();
    const box = () => result.current.api.terms[0];
    act(() => result.current.api.setDraft(box().id, 'error'));
    act(() => vi.advanceTimersByTime(300));
    expect(box().search).toBe('error');

    act(() => result.current.api.setDraft(box().id, 'errors'));
    act(() => result.current.api.setDraft(box().id, ''));
    expect(box().search).toBe('');
    act(() => vi.advanceTimersByTime(300));
    expect(box().search).toBe('');
  });

  it('does not bring back a box that was removed while its text was waiting', () => {
    const { result } = renderLogSearch();
    act(() => result.current.api.addTerm());
    const added = result.current.api.terms[1];
    act(() => result.current.api.setDraft(added.id, 'warn'));
    act(() => result.current.api.removeTerm(added.id));
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.api.terms.map(term => term.id)).toEqual([result.current.api.terms[0].id]);
  });

  it('keeps each process’s boxes apart', () => {
    const { result } = renderLogSearch();
    act(() => result.current.api.addTerm());
    act(() => result.current.api.setDraft(result.current.api.terms[0].id, 'error'));
    act(() => vi.advanceTimersByTime(300));

    expect(result.current.api.terms).toHaveLength(2);
    expect(result.current.api.terms[0].search).toBe('error');
    expect(result.current.worker.terms).toHaveLength(1);
    expect(result.current.worker.terms[0].search).toBe('');
  });

  it('stops adding boxes once every color is in use', () => {
    const { result } = renderLogSearch();
    for (let added = 0; added < MAX_SEARCH_TERMS + 2; added++) {
      act(() => result.current.api.addTerm());
    }
    expect(result.current.api.terms).toHaveLength(MAX_SEARCH_TERMS);
  });
});
