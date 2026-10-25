import { observeElementOffset, useVirtualizer } from '@tanstack/react-virtual';
import { Anchor, ArrowDown, Download, Pause, Play, Plus, TextWrap, X } from 'lucide-react';
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import { type IAnsiText, parseAnsi } from '@/lib/ansi';
import { type IHighlightLayer, compileSearchTerms, getSearchColorStyle } from '@/lib/highlight';
import { isTypingTarget, useShortcutHandler } from '@/lib/keyboard_shortcuts';
import { MAX_SEARCH_TERMS, useLogSearch } from '@/lib/log_search';
import { processRouteApi } from '@/lib/process_route';
import { trpc } from '@/lib/trpc';
import { cn, formatTimestamp } from '@/lib/utils';

import { Highlighted } from '@/components/highlighted';
import { SearchFilter } from '@/components/search_filter';
import { ShortcutHint } from '@/components/shortcut_hint';
import { Button, ToggleGroup } from '@/components/ui';

import type { ILogEntry, ILogView } from '@shared/contracts';

const MAX_LOADED_LINES = 20_000;
const MAX_PAUSED_LINES = 5_000;
const CORNER_BUTTON_SIZE = 30; // the Following/Jump button; logs end above it
const USER_SCROLL_WINDOW_MS = 500; // how long after wheel, touch or keys a scroll is the user's

// Each loaded line is parsed once: the search runs over all of them on every
// change, and a row renders again as it scrolls back into view.
const parsedTexts = new WeakMap<ILogEntry, IAnsiText>();

/** A line's text without its terminal escape codes, and the styles they set. */
function parseEntryText(entry: ILogEntry) {
  let parsed = parsedTexts.get(entry);
  if (!parsed) {
    parsed = parseAnsi(entry.text);
    parsedTexts.set(entry, parsed);
  }
  return parsed;
}

function hasSameLogEntries(previous: ILogEntry[], next: ILogEntry[]) {
  // History IDs change on every read. Compare snapshots, never deduplicate
  // individual lines: repeated identical messages are legitimate output.
  return (
    previous.length === next.length &&
    previous.every((entry, index) => {
      const candidate = next[index];
      return (
        entry.daemonId === candidate.daemonId &&
        entry.pmId === candidate.pmId &&
        entry.processName === candidate.processName &&
        entry.channel === candidate.channel &&
        entry.text === candidate.text &&
        entry.timestamp === candidate.timestamp &&
        entry.sequence === candidate.sequence
      );
    })
  );
}

/**
 * Set first letter in a string to uppercase. Doesn't touch other chars.
 */
function capitalize<T extends string>(str: T): Capitalize<T> {
  if (!str) {
    return str as any;
  }
  str = String(str) as any;
  return (str[0].toUpperCase() + str.slice(1)) as any;
}

const LogRow = memo(function LogRow({
  entry,
  wrap,
  highlights,
  canJumpToContext,
  focused,
  onReveal,
  offset,
  height,
  dataIndex,
  onMeasure,
}: {
  entry: ILogEntry;
  wrap: boolean;
  highlights: readonly IHighlightLayer[];
  canJumpToContext: boolean;
  focused: boolean;
  onReveal: (entryId: string) => void;
  offset: number;
  height: number;
  dataIndex?: number;
  onMeasure?: (element: HTMLDivElement | null) => void;
}) {
  const timestamp = useMemo(() => formatTimestamp(entry.timestamp), [entry.timestamp]);
  const { text, runs } = parseEntryText(entry);

  return (
    <div
      data-component="LogRow"
      data-index={dataIndex}
      ref={onMeasure}
      data-entry-id={entry.id}
      className={cn(
        'absolute top-0 left-0 grid w-full grid-cols-[4px_104px_minmax(0,1fr)] gap-3 px-5 py-1 font-mono text-[12px] leading-5',
        entry.channel === 'err' && 'bg-danger/5',
        focused && 'bg-cyan/10 ring-1 ring-inset ring-cyan/40'
      )}
      style={{ height: wrap ? undefined : `${height}px`, transform: `translateY(${offset}px)` }}
    >
      <i
        className={cn(
          'h-full min-h-5 rounded-full',
          entry.channel === 'err' ? 'bg-danger' : 'bg-[#31516a]'
        )}
      />
      {canJumpToContext ? (
        <button
          type="button"
          className="select-none text-left text-muted underline-offset-2 hover:text-cyan hover:underline"
          title="Stop filtering and show surrounding log context"
          onClick={() => onReveal(entry.id)}
        >
          {timestamp}
        </button>
      ) : (
        <span className="select-none text-muted">{timestamp}</span>
      )}
      <span
        className={cn(
          wrap ? 'whitespace-pre-wrap break-words text-[#d8e8f5]' : 'whitespace-pre text-[#d8e8f5]',
          entry.channel === 'err' && 'text-[#ff8c9e]'
        )}
      >
        <Highlighted text={text} regex={null} highlights={highlights} hasLinks styles={runs} />
      </span>
    </div>
  );
});

export function LogsPage({ connectionId }: { connectionId: string | undefined }) {
  // Logs exist for one process only; the route redirects a selection elsewhere.
  const { daemonId, numericId } = processRouteApi.useParams({
    select: ({ daemonId, pmIds }) => ({ daemonId, numericId: pmIds[0] ?? 0 }),
    structuralSharing: true,
  });
  const [view, setView] = useState<ILogView>('combined');
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  const isFollowingRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  // The virtualizer moves the view too (keeping lines in place, settling row
  // heights), so a scroll event alone does not mean the user scrolled.
  const userScrollUntilRef = useRef(0);
  const isPointerDownRef = useRef(false);
  // Mirrors the ref for rendering the corner button; scroll handlers read the ref.
  const [isFollowing, setIsFollowing] = useState(true);
  const setFollowing = useCallback((next: boolean) => {
    isFollowingRef.current = next;
    setIsFollowing(next);
  }, []);
  const hasGapRef = useRef(false);
  const hasStreamUpdatesRef = useRef(false);
  const [isCatchingUp, setIsCatchingUp] = useState(false);
  const isCatchingUpRef = useRef(false);
  const lifetimeRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const pageInput = useMemo(
    () => ({ daemonId, connectionId, pmId: numericId, view, cursor: null, limit: 500 }),
    [daemonId, connectionId, numericId, view]
  );
  const shouldRefresh = () =>
    !pausedRef.current && isFollowingRef.current && !isCatchingUpRef.current;
  const initialPage = trpc.logs.page.useQuery(
    pageInput,
    // Catch up automatically only while following. Paused and older history
    // remain frozen until Resume or Jump to latest explicitly requests a snapshot.
    {
      enabled: connectionId !== undefined,
      staleTime: 0,
      refetchOnMount: shouldRefresh,
      refetchOnWindowFocus: shouldRefresh,
      refetchOnReconnect: shouldRefresh,
      trpc: { abortOnUnmount: true },
    }
  );
  const [entries, setEntries] = useState<ILogEntry[]>(() => initialPage.data?.entries ?? []);
  const [cursor, setCursor] = useState<string | null>(() => initialPage.data?.cursor ?? null);
  const [hasMore, setHasMore] = useState(() => initialPage.data?.hasMore ?? false);
  const [sharedFile, setSharedFile] = useState(() => initialPage.data?.sharedFile ?? false);
  const sourceRef = useRef({ daemonId, numericId, view });
  const appliedPageRef = useRef(initialPage.data);
  const [bufferedCount, setBufferedCount] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [wrap, setWrap] = useState(true);
  const logSearch = useLogSearch(daemonId, numericId);
  const { terms, getDraft, setDraft, updateTerm } = logSearch;
  const searchBoxesRef = useRef<HTMLDivElement>(null);
  const shouldFocusNewBoxRef = useRef(false);
  // Keep the boxes snappy; defer the expensive re-filter/highlight pass.
  const deferredTerms = useDeferredValue(terms);
  const compiledSearch = useMemo(() => compileSearchTerms(deferredTerms), [deferredTerms]);
  const isFiltered = compiledSearch.filters.length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  // The corner button sits inside the scrollbars, so it needs their size.
  const [scrollbarSize, setScrollbarSize] = useState({ width: 0, height: 0 });
  const bufferRef = useRef<ILogEntry[]>([]);
  const pendingJumpIdRef = useRef<string | null>(null);
  const [focusedEntryId, setFocusedEntryId] = useState<string | null>(null);
  const utils = trpc.useUtils();

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    lifetimeRef.current++;
    setIsCatchingUp(false);
    isCatchingUpRef.current = false;
    return () => {
      // Activity stops effects when hidden, but async continuations also need
      // cancellation and a generation check before updating retained state.
      lifetimeRef.current++;
      hasGapRef.current = true;
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [daemonId, numericId, view]);

  useEffect(() => {
    const source = sourceRef.current;
    if (source.daemonId === daemonId && source.numericId === numericId && source.view === view) {
      return;
    }
    sourceRef.current = { daemonId, numericId, view };
    appliedPageRef.current = undefined;
    hasGapRef.current = false;
    hasStreamUpdatesRef.current = false;
    setEntries([]);
    setCursor(null);
    setHasMore(false);
    setSharedFile(false);
    setPaused(false);
    pausedRef.current = false;
    bufferRef.current = [];
    setBufferedCount(0);
    setDropped(0);
    setFollowing(true);
  }, [daemonId, numericId, view, setFollowing]);

  useEffect(() => {
    if (
      !initialPage.data ||
      appliedPageRef.current === initialPage.data ||
      pausedRef.current ||
      !isFollowingRef.current ||
      isCatchingUpRef.current
    ) {
      return;
    }
    const previous = appliedPageRef.current;
    appliedPageRef.current = initialPage.data;
    hasGapRef.current = false;
    // An unchanged newest page must also preserve older loaded pages/cursors.
    if (
      !hasStreamUpdatesRef.current &&
      previous &&
      hasSameLogEntries(previous.entries, initialPage.data.entries)
    ) {
      return;
    }
    hasStreamUpdatesRef.current = false;
    setEntries(initialPage.data.entries);
    setCursor(initialPage.data.cursor);
    setHasMore(initialPage.data.hasMore);
    setSharedFile(initialPage.data.sharedFile);
  }, [initialPage.data]);

  trpc.logs.stream.useSubscription(
    { daemonId, connectionId, pmId: numericId, view },
    {
      enabled: !isCatchingUp && connectionId !== undefined,
      onData(event) {
        if (event.type === 'daemon-status') {
          if (!event.connected) {
            // Output written while the stream is down is not replayed.
            hasGapRef.current = true;
            toast.warning(event.message || 'PM2 stream disconnected');
          } else if (hasGapRef.current && shouldRefresh()) {
            void refreshLatest();
          }
          return;
        }
        if (!event.entry || isCatchingUpRef.current) {
          return;
        }
        if (pausedRef.current) {
          if (bufferRef.current.length >= MAX_PAUSED_LINES) {
            bufferRef.current.shift();
            setDropped(value => value + 1);
          }
          bufferRef.current.push(event.entry);
          setBufferedCount(bufferRef.current.length);
          return;
        }
        hasStreamUpdatesRef.current = true;
        setEntries(current => [...current, event.entry!].slice(-MAX_LOADED_LINES));
      },
      onError(error) {
        hasGapRef.current = true;
        toast.error(`Log stream: ${error.message}`);
      },
    }
  );

  const refreshLatest = async () => {
    if (isCatchingUpRef.current) {
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const lifetime = ++lifetimeRef.current;
    isCatchingUpRef.current = true;
    // A failed or interrupted read still leaves a gap while the stream stopped.
    hasGapRef.current = true;
    setIsCatchingUp(true);
    try {
      await utils.logs.page.cancel(pageInput);
      if (controller.signal.aborted || lifetime !== lifetimeRef.current) {
        return;
      }
      const page = await utils.client.logs.page.query(pageInput, { signal: controller.signal });
      if (controller.signal.aborted || lifetime !== lifetimeRef.current) {
        return;
      }
      // History and live entries have no shared stable ID. Replace the snapshot
      // and discard the paused buffer together to avoid replaying it twice.
      appliedPageRef.current = page;
      utils.logs.page.setData(pageInput, page);
      hasGapRef.current = false;
      hasStreamUpdatesRef.current = false;
      bufferRef.current = [];
      setBufferedCount(0);
      setDropped(0);
      pausedRef.current = false;
      setPaused(false);
      // A snapshot replaces every line, so the old reading position means nothing.
      setFollowing(true);
      setEntries(page.entries);
      setCursor(page.cursor);
      setHasMore(page.hasMore);
      setSharedFile(page.sharedFile);
    } catch (error) {
      if (!controller.signal.aborted && lifetime === lifetimeRef.current) {
        toast.error(error instanceof Error ? error.message : 'Failed to load latest logs');
      }
    } finally {
      if (lifetime === lifetimeRef.current) {
        requestRef.current = null;
        isCatchingUpRef.current = false;
        setIsCatchingUp(false);
      }
    }
  };

  const resume = () => {
    if (hasGapRef.current || !appliedPageRef.current) {
      void refreshLatest();
      return;
    }
    const buffered = bufferRef.current;
    bufferRef.current = [];
    setBufferedCount(0);
    setPaused(false);
    pausedRef.current = false;
    hasStreamUpdatesRef.current ||= buffered.length > 0;
    setEntries(current => [...current, ...buffered].slice(-MAX_LOADED_LINES));
  };

  const loadOlder = useCallback(async () => {
    if (!hasMore || !cursor || requestRef.current || isCatchingUpRef.current) {
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    const lifetime = lifetimeRef.current;
    try {
      const page = await utils.client.logs.page.query(
        {
          daemonId,
          connectionId,
          pmId: numericId,
          view,
          cursor,
          limit: 500,
        },
        { signal: controller.signal }
      );
      if (controller.signal.aborted || lifetime !== lifetimeRef.current) {
        return;
      }
      setEntries(current => [...page.entries, ...current].slice(-MAX_LOADED_LINES));
      setCursor(page.cursor);
      setHasMore(page.hasMore);
      setSharedFile(page.sharedFile);
      if (page.rotated) {
        toast.warning('The active log file rotated; history cursor was reset.');
      }
    } catch (error) {
      if (!controller.signal.aborted && lifetime === lifetimeRef.current) {
        toast.error(error instanceof Error ? error.message : 'Failed to load older logs');
      }
    } finally {
      if (lifetime === lifetimeRef.current) {
        requestRef.current = null;
      }
    }
  }, [cursor, hasMore, daemonId, connectionId, numericId, utils.client.logs.page, view]);

  const filteredEntries = useMemo(() => {
    const { filters } = compiledSearch;
    if (!filters.length) {
      return entries;
    }
    return entries.filter(entry =>
      filters.every(filter => {
        filter.lastIndex = 0;
        return filter.test(parseEntryText(entry).text);
      })
    );
  }, [compiledSearch, entries]);

  const isFilterPending = terms !== deferredTerms;

  const revealLogEntry = useCallback(
    (entryId: string) => {
      setFollowing(false);
      pendingJumpIdRef.current = entryId;
      setFocusedEntryId(entryId);
      // Only the filters hide the neighbours. They keep their text and go on
      // highlighting, so the match stays easy to spot among them.
      for (const term of terms) {
        if (term.isFilter && (getDraft(term) || term.search)) {
          updateTerm(term.id, { isFilter: false });
        }
      }
    },
    [getDraft, setFollowing, terms, updateTerm]
  );

  const downloadFilteredLogs = useCallback(() => {
    if (!filteredEntries.length) {
      toast.message('No log lines to download');
      return;
    }
    const body = filteredEntries
      .map(entry => {
        const timestamp = entry.timestamp ? new Date(entry.timestamp).toISOString() : '';
        const channel = entry.channel === 'err' ? 'ERR' : 'OUT';
        return `${timestamp} [${channel}] ${entry.text}`;
      })
      .join('\n');
    const blob = new Blob([body.endsWith('\n') ? body : `${body}\n`], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    anchor.href = url;
    anchor.download = `pm2-${numericId}-${view}${isFiltered ? '-filtered' : ''}-${stamp}.log`;
    anchor.click();
    // The desktop app asks where to save before it reads the file.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, [filteredEntries, isFiltered, numericId, view]);

  // Measure wrapped rows at their actual height; only visible rows and overscan
  // enter the DOM, even when thousands of lines are loaded.
  const virtualizer = useVirtualizer({
    count: filteredEntries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (wrap ? 28 : 24),
    overscan: 20,
    paddingEnd: CORNER_BUTTON_SIZE,
    // Lines come and go at both ends: older history is prepended, and a full
    // buffer drops its oldest lines as new ones arrive. Keep the line at the
    // top of the view in place, so reading older lines is not swept along.
    anchorTo: 'end',
    // Batch scroll/measurement notifications instead of synchronously rebuilding
    // the log viewport for each one. Overscan covers movement before the commit.
    useFlushSync: false,
    observeElementOffset: (instance, onOffset) => {
      let isActive = true;
      const stop = observeElementOffset(instance, (offset, isScrolling) => {
        // Its debounced scroll-end callback can outlive observer cleanup.
        // Activity must not restore an offset from a previous visible interval.
        if (isActive) {
          onOffset(offset, isScrolling);
        }
      });
      return () => {
        isActive = false;
        stop?.();
      };
    },
    getItemKey: useCallback(
      (index: number) => filteredEntries[index]?.id ?? index,
      [filteredEntries]
    ),
  });
  const totalSize = virtualizer.getTotalSize();
  const measuredWrapRef = useRef(wrap);
  const pinToBottom = useCallback(() => {
    if (!isFollowingRef.current) {
      return;
    }
    // Let the virtualizer reconcile the last row as wrapped heights are measured.
    virtualizer.scrollToEnd();
  }, [virtualizer]);

  // Keep pinned to bottom after React/virtualizer layout when following.
  useLayoutEffect(() => {
    pinToBottom();
  }, [pinToBottom, filteredEntries, totalSize, wrap, compiledSearch]);

  useLayoutEffect(() => {
    if (measuredWrapRef.current !== wrap) {
      measuredWrapRef.current = wrap;
      virtualizer.measure();
    }
  }, [virtualizer, wrap]);

  // Once no filter hides lines, scroll the chosen line into full-context view.
  useLayoutEffect(() => {
    const entryId = pendingJumpIdRef.current;
    if (!entryId || isFiltered) {
      return;
    }
    const index = entries.findIndex(entry => entry.id === entryId);
    if (index < 0) {
      pendingJumpIdRef.current = null;
      return;
    }
    pendingJumpIdRef.current = null;
    setFollowing(false);

    virtualizer.scrollToIndex(index, { align: 'center' });
  }, [entries, isFiltered, setFollowing, virtualizer, wrap]);

  const measureScrollbars = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const width = element.offsetWidth - element.clientWidth;
    const height = element.offsetHeight - element.clientHeight;
    setScrollbarSize(current =>
      current.width === width && current.height === height ? current : { width, height }
    );
  }, []);

  // Scrollbars come and go with the content, which a ResizeObserver does not report.
  useLayoutEffect(measureScrollbars, [measureScrollbars, totalSize, wrap]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(measureScrollbars);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measureScrollbars]);

  // A box added with + starts focused. The boxes are kept for the whole app, so
  // they cannot use autoFocus: they mount again on every process's logs.
  useEffect(() => {
    if (shouldFocusNewBoxRef.current) {
      shouldFocusNewBoxRef.current = false;
      Array.from(searchBoxesRef.current?.querySelectorAll('input') ?? [])
        .at(-1)
        ?.focus();
    }
  }, [terms.length]);

  useEffect(() => {
    if (!focusedEntryId) {
      return;
    }
    const timer = window.setTimeout(() => setFocusedEntryId(null), 2_500);
    return () => window.clearTimeout(timer);
  }, [focusedEntryId]);

  // Back to the newest loaded line. A pause stays as it is; only a view that missed
  // lines (hidden, disconnected, or dropped while paused) takes a fresh snapshot.
  const jumpToLatest = () => {
    if ((hasGapRef.current || dropped > 0) && !pausedRef.current) {
      void refreshLatest();
      return;
    }
    setFollowing(true);
    virtualizer.scrollToEnd();
  };

  const markUserScroll = () => {
    userScrollUntilRef.current = performance.now() + USER_SCROLL_WINDOW_MS;
  };

  // End is the corner button's Jump to latest, which also follows new lines again.
  useShortcutHandler('logs.latest', () => {
    jumpToLatest();
  });

  // The keyboard scrolls the list when it was clicked last, without focusing it,
  // so its own key events would miss Page Down and friends.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTypingTarget(event.target)) {
        markUserScroll();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const cornerButtonStyle = {
    right: scrollbarSize.width,
    bottom: scrollbarSize.height,
    width: CORNER_BUTTON_SIZE,
    height: CORNER_BUTTON_SIZE,
  };

  return (
    <div data-component="LogsPage" className="flex min-h-0 flex-1 flex-col bg-surface-plane">
      {/* Left to right: what is shown (stream, filter, highlights), then what is loaded
          (count and download) and the stream controls. */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-line bg-surface-control px-3 py-3 sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-3 sm:px-7 lg:min-h-(--height-detail-toolbar) lg:flex-nowrap lg:py-[11px]">
        <ToggleGroup aria-label="Log stream filter" className="self-start sm:self-auto">
          {(['combined', 'out', 'err'] as const).map(option => (
            <Button
              key={option}
              variant="toggle"
              aria-pressed={view === option}
              className="h-9 px-3 font-mono text-xs"
              onClick={() => setView(option)}
            >
              {option === 'combined' ? 'All' : capitalize(option)}
            </Button>
          ))}
        </ToggleGroup>

        {/* Each box filters or only highlights, in its own color. Boxes keep one width,
            so adding one never resizes the others; it fits on the row or wraps. */}
        <div ref={searchBoxesRef} className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-1">
          {terms.map((term, index) => (
            <div
              key={term.id}
              className="flex min-w-0 flex-1 basis-60 items-center sm:flex-none"
              style={getSearchColorStyle(term.color)}
            >
              {index > 0 ? (
                // A tab on the box's edge, in the color the box paints its matches.
                <button
                  type="button"
                  aria-label="Close box"
                  title="Close box"
                  className="flex h-6 w-5 shrink-0 items-center justify-center rounded-l-md border border-r-0 border-line bg-key text-(--mark) hover:bg-key-hover focus-visible:outline-2 focus-visible:outline-cyan"
                  onClick={() => logSearch.removeTerm(term.id)}
                >
                  <X className="size-3" strokeWidth={2.5} />
                </button>
              ) : null}
              <SearchFilter
                draft={getDraft(term)}
                phase={logSearch.getPhase(term)}
                onDraftChange={next => setDraft(term.id, next)}
                caseSensitive={term.isCaseSensitive}
                onCaseSensitiveChange={next =>
                  logSearch.updateTerm(term.id, { isCaseSensitive: next })
                }
                regex={term.isRegex}
                onRegexChange={next => logSearch.updateTerm(term.id, { isRegex: next })}
                isFilter={term.isFilter}
                onIsFilterChange={next => logSearch.updateTerm(term.id, { isFilter: next })}
                hasSearchIcon={false}
                // Ctrl+F comes here after the process filter in the sidebar.
                findStep={2}
                onGoToList={() => scrollRef.current?.focus()}
                placeholder={term.isFilter ? 'Filter loaded logs…' : 'Highlight loaded logs…'}
                className="max-w-full min-w-0 flex-1 sm:w-[22rem] sm:max-w-full sm:flex-none"
              />
            </div>
          ))}
          {terms.length < MAX_SEARCH_TERMS ? (
            <Button
              variant="toggle"
              aria-label="Add a search box"
              title="Add a box that filters or highlights, in its own color"
              className="size-7 shrink-0 rounded-md p-0"
              onClick={() => {
                shouldFocusNewBoxRef.current = true;
                logSearch.addTerm();
              }}
            >
              <Plus className="size-3.5" strokeWidth={2.5} />
            </Button>
          ) : null}
        </div>

        {/* The count leads a right-aligned group, so when it gets longer it grows
            to the left and the controls after it stay put. */}
        <div className="flex items-center justify-end gap-2 sm:ml-auto">
          <div className="flex h-9 items-stretch overflow-hidden rounded-lg border border-line">
            <span
              className="inline-flex min-w-9 items-center justify-center px-2.5 font-mono text-[11px] text-muted"
              title={isFiltered ? 'Filtered / loaded lines' : 'Loaded lines'}
            >
              {isFiltered ? `${filteredEntries.length}/${entries.length}` : entries.length}
            </span>
            <Button
              variant="toggle"
              aria-label="Download filtered logs"
              className="w-9 shrink-0 rounded-none border-0 border-l border-line p-0 shadow-none focus-visible:outline-offset-[-2px] active:translate-y-0"
              title="Download filtered logs"
              disabled={!filteredEntries.length}
              onClick={downloadFilteredLogs}
            >
              <Download className="size-3.5" />
            </Button>
          </div>
          <div className="relative">
            <Button
              variant="toggle"
              aria-pressed={paused}
              disabled={isCatchingUp}
              className={cn(
                'h-9 w-[6.5rem] gap-1.5 px-2.5 text-xs',
                paused &&
                  'aria-pressed:border-warning/50 aria-pressed:bg-warning/15 aria-pressed:text-warning aria-pressed:shadow-[inset_0_2px_4px_rgb(0_0_0_/_0.32),inset_0_0_0_1px_rgb(246_183_0_/_0.55)] aria-pressed:hover:bg-warning/25'
              )}
              onClick={() => {
                if (paused) {
                  resume();
                } else {
                  pausedRef.current = true;
                  void utils.logs.page.cancel(pageInput);
                  setPaused(true);
                }
              }}
            >
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              {paused ? 'Resume' : 'Pause'}
            </Button>
            {paused && bufferedCount > 0 ? (
              <span className="pointer-events-none absolute -right-1.5 -top-1.5 z-10 min-w-5 rounded-full border border-warning/50 bg-warning px-1.5 py-0.5 text-center font-mono text-[10px] font-bold leading-none text-accent-ink">
                {bufferedCount}
              </span>
            ) : null}
          </div>
          <Button
            variant="toggle"
            aria-label="Wrap lines"
            aria-pressed={wrap}
            className="size-9 p-0"
            title="Wrap lines"
            onClick={() => setWrap(value => !value)}
          >
            <TextWrap className="size-4" />
          </Button>
        </div>
      </div>

      {sharedFile || dropped || compiledSearch.error ? (
        <div className="shrink-0 space-y-3 px-3 py-3 sm:px-7">
          {sharedFile ? (
            <div className="rounded-lg border border-cyan/30 bg-cyan/5 px-4 py-2 font-mono text-xs text-cyan">
              stdout and stderr share one active file; historical channel separation is unavailable.
            </div>
          ) : null}
          {dropped ? (
            <div className="rounded-lg border border-danger/40 bg-danger/8 px-4 py-2 font-mono text-xs text-danger">
              {dropped} paused events were dropped from memory. Jump to the latest lines to recover
              them.
            </div>
          ) : null}
          {compiledSearch.error ? (
            <div className="font-mono text-xs text-danger">{compiledSearch.error}</div>
          ) : null}
        </div>
      ) : null}

      {/* The lines' focus ring is drawn here, above the corner button, which would
          otherwise cover its edge. */}
      <div
        className={cn(
          'relative min-h-0 flex-1 after:pointer-events-none after:absolute after:inset-0 after:z-20 has-[[data-process-pane]:focus-visible]:after:outline-2 has-[[data-process-pane]:focus-visible]:after:-outline-offset-2 has-[[data-process-pane]:focus-visible]:after:outline-cyan/70',
          isFilterPending && 'opacity-80'
        )}
      >
        {/* Docked in the corner inside the scrollbars: a flat anchor while new lines
            scroll into view, a raised key to get back to them otherwise. */}
        {isFollowing && !dropped ? (
          <button
            type="button"
            aria-label="Anchored to the latest line"
            aria-pressed
            title={
              paused
                ? 'Anchored to the latest line; new lines wait until you resume. Click to stay here'
                : 'Anchored: new lines scroll into view. Click to stay here'
            }
            className="absolute z-10 flex items-center justify-center rounded-tl-lg border-t border-l border-line bg-key-pressed text-cyan shadow-[inset_0_2px_4px_rgb(0_0_0_/_0.42)] hover:bg-key focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan"
            style={cornerButtonStyle}
            onClick={() => setFollowing(false)}
          >
            <Anchor className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Jump to latest"
            title="Jump to latest"
            disabled={isCatchingUp}
            className="absolute z-10 flex items-center justify-center rounded-tl-lg border-t border-l border-line bg-key text-white shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08)] hover:bg-key-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-45"
            style={cornerButtonStyle}
            onClick={jumpToLatest}
          >
            <ArrowDown className="size-4" strokeWidth={2.25} />
            <ShortcutHint action="logs.latest" className="right-0 bottom-full mb-1.5" />
          </button>
        )}
        <div
          ref={scrollRef}
          // Enter in a search box or the process list comes here, where the keys
          // scroll the lines (PROCESS_PANE_ATTRIBUTE).
          data-process-pane
          tabIndex={0}
          aria-label="Log lines"
          className="h-full min-h-0 overflow-auto [overflow-anchor:none] focus-visible:outline-none"
          onWheel={markUserScroll}
          onTouchMove={markUserScroll}
          onPointerDown={() => {
            // Covers dragging the scrollbar, which sends no events while it moves.
            isPointerDownRef.current = true;
            const release = () => {
              isPointerDownRef.current = false;
              window.removeEventListener('pointerup', release);
              window.removeEventListener('pointercancel', release);
            };
            window.addEventListener('pointerup', release);
            window.addEventListener('pointercancel', release);
          }}
          onScroll={event => {
            const element = event.currentTarget;
            if (!element.clientHeight) {
              return;
            }
            const isAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
            const isScrollingDown = element.scrollTop > lastScrollTopRef.current;
            lastScrollTopRef.current = element.scrollTop;
            const isUserScroll =
              isPointerDownRef.current || performance.now() < userScrollUntilRef.current;
            // Following starts again only when the user scrolls down to the end, so
            // the virtualizer's own adjustments cannot undo a click on the anchor.
            if (
              isFollowingRef.current ? !isAtBottom : isAtBottom && isScrollingDown && isUserScroll
            ) {
              setFollowing(isAtBottom);
            }
            if (element.scrollTop < 32) {
              void loadOlder();
            }
          }}
        >
          {initialPage.isLoading && !entries.length ? (
            <div className="p-8 text-center font-mono text-xs text-muted">Loading active logs…</div>
          ) : !filteredEntries.length ? (
            <div className="p-8 text-center font-mono text-xs text-muted">
              {isFiltered
                ? 'No loaded lines match the search.'
                : 'No log lines in the active file yet.'}
            </div>
          ) : (
            <div className="relative w-full" style={{ height: `${totalSize}px` }}>
              {virtualizer.getVirtualItems().map(virtualRow => {
                const entry = filteredEntries[virtualRow.index];
                return (
                  <LogRow
                    key={virtualRow.key}
                    entry={entry}
                    wrap={wrap}
                    highlights={compiledSearch.layers}
                    canJumpToContext={isFiltered}
                    focused={focusedEntryId === entry.id}
                    onReveal={revealLogEntry}
                    dataIndex={virtualRow.index}
                    onMeasure={wrap ? virtualizer.measureElement : undefined}
                    // Primitive positions let memoized rows survive query and
                    // scroll-state renders when their content/geometry is unchanged.
                    height={virtualRow.size}
                    offset={virtualRow.start}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
