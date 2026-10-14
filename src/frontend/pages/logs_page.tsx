import { observeElementOffset, useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownToLine, Download, Pause, Play, TextWrap } from 'lucide-react';
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

import { useDebouncedSearch } from '@/lib/debounce';
import { processRouteApi } from '@/lib/process_route';
import { trpc } from '@/lib/trpc';
import { cn, formatTimestamp } from '@/lib/utils';

import { Highlighted, buildHighlightRegex } from '@/components/highlighted';
import { SearchFilter } from '@/components/search_filter';
import { Button, ToggleGroup } from '@/components/ui';

import type { ILogEntry, ILogView } from '@shared/contracts';

const MAX_LOADED_LINES = 20_000;
const MAX_PAUSED_LINES = 5_000;
const SEARCH_DEBOUNCE_MS = 300; // quiet period before applying filter

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
  highlight,
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
  highlight: RegExp | null;
  canJumpToContext: boolean;
  focused: boolean;
  onReveal: (entryId: string) => void;
  offset: number;
  height: number;
  dataIndex?: number;
  onMeasure?: (element: HTMLDivElement | null) => void;
}) {
  const timestamp = useMemo(() => formatTimestamp(entry.timestamp), [entry.timestamp]);

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
          title="Clear filter and show surrounding log context"
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
        <Highlighted text={entry.text} regex={highlight} />
      </span>
    </div>
  );
});

export function LogsPage() {
  // Logs exist for one process only; the route redirects a selection elsewhere.
  const { daemonId, numericId } = processRouteApi.useParams({
    select: ({ daemonId, pmIds }) => ({ daemonId, numericId: pmIds[0] ?? 0 }),
    structuralSharing: true,
  });
  const [view, setView] = useState<ILogView>('combined');
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  const isFollowingRef = useRef(true);
  const hasGapRef = useRef(false);
  const hasStreamUpdatesRef = useRef(false);
  const [isCatchingUp, setIsCatchingUp] = useState(false);
  const isCatchingUpRef = useRef(false);
  const lifetimeRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const pageInput = useMemo(
    () => ({ daemonId, pmId: numericId, view, cursor: null, limit: 500 }),
    [daemonId, numericId, view]
  );
  const shouldRefresh = () =>
    !pausedRef.current && isFollowingRef.current && !isCatchingUpRef.current;
  const initialPage = trpc.logs.page.useQuery(
    pageInput,
    // Catch up automatically only while following. Paused and older history
    // remain frozen until Resume or Jump to latest explicitly requests a snapshot.
    {
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
  const {
    draft: searchDraft,
    value: search,
    phase: searchPhase,
    setDraft: setSearchDraft,
  } = useDebouncedSearch(SEARCH_DEBOUNCE_MS);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  // Keep toggle UI snappy; defer the expensive re-filter/highlight pass.
  const deferredSearch = useDeferredValue(search);
  const deferredCaseSensitive = useDeferredValue(caseSensitive);
  const deferredRegex = useDeferredValue(regex);
  const scrollRef = useRef<HTMLDivElement>(null);
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
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
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
    isFollowingRef.current = true;
  }, [daemonId, numericId, view]);

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
    { daemonId, pmId: numericId, view },
    {
      enabled: !isCatchingUp,
      onData(event) {
        if (event.type === 'daemon-status') {
          if (!event.connected) {
            toast.warning(event.message || 'PM2 stream disconnected');
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
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
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
      isFollowingRef.current = true;
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
    isFollowingRef.current = true;
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
    const element = scrollRef.current;
    const previousHeight = element?.scrollHeight || 0;
    try {
      const page = await utils.client.logs.page.query(
        {
          daemonId,
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
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        if (element && lifetime === lifetimeRef.current && !controller.signal.aborted) {
          element.scrollTop = element.scrollHeight - previousHeight;
        }
      });
    } catch (error) {
      if (!controller.signal.aborted && lifetime === lifetimeRef.current) {
        toast.error(error instanceof Error ? error.message : 'Failed to load older logs');
      }
    } finally {
      if (lifetime === lifetimeRef.current) {
        requestRef.current = null;
      }
    }
  }, [cursor, hasMore, daemonId, numericId, utils.client.logs.page, view]);

  const searchResult = useMemo(() => {
    if (!deferredSearch) {
      return { entries, error: '', highlight: null as RegExp | null };
    }
    try {
      const highlight = buildHighlightRegex(deferredSearch, {
        caseSensitive: deferredCaseSensitive,
        regex: deferredRegex,
      });
      return {
        entries: entries.filter(entry => {
          highlight.lastIndex = 0;
          return highlight.test(entry.text);
        }),
        error: '',
        highlight,
      };
    } catch (error) {
      return {
        entries,
        error: error instanceof Error ? error.message : 'Invalid expression',
        highlight: null as RegExp | null,
      };
    }
  }, [deferredCaseSensitive, deferredRegex, deferredSearch, entries]);

  const filteredEntries = searchResult.entries;
  const canJumpToContext = Boolean(deferredSearch);
  const isFilterPending =
    search !== deferredSearch || caseSensitive !== deferredCaseSensitive || regex !== deferredRegex;

  const revealLogEntry = useCallback(
    (entryId: string) => {
      isFollowingRef.current = false;
      pendingJumpIdRef.current = entryId;
      setFocusedEntryId(entryId);
      if (searchDraft || search) {
        setSearchDraft('');
      }
    },
    [search, searchDraft, setSearchDraft]
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
    anchor.download = `pm2-${numericId}-${view}${deferredSearch ? '-filtered' : ''}-${stamp}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [deferredSearch, filteredEntries, numericId, view]);

  // Measure wrapped rows at their actual height; only visible rows and overscan
  // enter the DOM, even when thousands of lines are loaded.
  const virtualizer = useVirtualizer({
    count: filteredEntries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (wrap ? 28 : 24),
    overscan: 20,
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
  }, [pinToBottom, filteredEntries, totalSize, wrap, deferredSearch]);

  useLayoutEffect(() => {
    if (measuredWrapRef.current !== wrap) {
      measuredWrapRef.current = wrap;
      virtualizer.measure();
    }
  }, [virtualizer, wrap]);

  // After clearing a filter, scroll the chosen line into full-context view.
  useLayoutEffect(() => {
    const entryId = pendingJumpIdRef.current;
    if (!entryId || deferredSearch) {
      return;
    }
    const index = entries.findIndex(entry => entry.id === entryId);
    if (index < 0) {
      pendingJumpIdRef.current = null;
      return;
    }
    pendingJumpIdRef.current = null;
    isFollowingRef.current = false;

    virtualizer.scrollToIndex(index, { align: 'center' });
  }, [deferredSearch, entries, virtualizer, wrap]);

  useEffect(() => {
    if (!focusedEntryId) {
      return;
    }
    const timer = window.setTimeout(() => setFocusedEntryId(null), 2_500);
    return () => window.clearTimeout(timer);
  }, [focusedEntryId]);

  return (
    <div data-component="LogsPage" className="flex min-h-0 flex-1 flex-col bg-surface-plane">
      <div className="grid shrink-0 grid-cols-1 items-center gap-2 border-b border-line bg-surface-control px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:px-7 lg:h-detail-toolbar lg:py-0">
        <div className="flex justify-start">
          <ToggleGroup aria-label="Log stream filter">
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
        </div>

        <div className="flex min-w-0 items-center justify-center">
          <SearchFilter
            draft={searchDraft}
            phase={searchPhase}
            onDraftChange={setSearchDraft}
            caseSensitive={caseSensitive}
            onCaseSensitiveChange={next => setCaseSensitive(next)}
            regex={regex}
            onRegexChange={next => setRegex(next)}
            placeholder="Filter loaded logs…"
          />
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="toggle"
            aria-label="Jump to latest"
            title="Jump to latest"
            className="size-9 p-0"
            disabled={isCatchingUp}
            onClick={() => void refreshLatest()}
          >
            <ArrowDownToLine className="size-4" />
          </Button>
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
        </div>
      </div>

      {sharedFile || dropped || searchResult.error ? (
        <div className="shrink-0 space-y-3 px-3 py-3 sm:px-7">
          {sharedFile ? (
            <div className="rounded-lg border border-cyan/30 bg-cyan/5 px-4 py-2 font-mono text-xs text-cyan">
              stdout and stderr share one active file; historical channel separation is unavailable.
            </div>
          ) : null}
          {dropped ? (
            <div className="rounded-lg border border-danger/40 bg-danger/8 px-4 py-2 font-mono text-xs text-danger">
              {dropped} paused events were dropped from memory. Load history to recover them.
            </div>
          ) : null}
          {searchResult.error ? (
            <div className="font-mono text-xs text-danger">{searchResult.error}</div>
          ) : null}
        </div>
      ) : null}

      <div className={cn('relative min-h-0 flex-1', isFilterPending && 'opacity-80')}>
        <div className="absolute top-2 right-2 z-10 flex h-8 items-stretch overflow-hidden rounded-lg border border-line/80 bg-surface-plane/90 shadow-lg backdrop-blur-sm">
          <span
            className="inline-flex min-w-8 items-center justify-center px-2.5 font-mono text-[11px] text-muted"
            title={deferredSearch ? 'Filtered / loaded lines' : 'Loaded lines'}
          >
            {deferredSearch ? `${searchResult.entries.length}/${entries.length}` : entries.length}
          </span>
          <Button
            variant="toggle"
            aria-label="Download filtered logs"
            className="size-8 shrink-0 rounded-none border-0 border-l border-line/80 p-0 shadow-none focus-visible:outline-offset-[-2px] active:translate-y-0"
            title="Download filtered logs"
            disabled={!filteredEntries.length}
            onClick={downloadFilteredLogs}
          >
            <Download className="size-3.5" />
          </Button>
        </div>
        <div
          ref={scrollRef}
          className="h-full min-h-0 overflow-auto [overflow-anchor:none]"
          onScroll={event => {
            const element = event.currentTarget;
            if (!element.clientHeight) {
              return;
            }
            isFollowingRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 48;
            if (element.scrollTop < 32) {
              void loadOlder();
            }
          }}
        >
          {initialPage.isLoading && !entries.length ? (
            <div className="p-8 text-center font-mono text-xs text-muted">Loading active logs…</div>
          ) : !filteredEntries.length ? (
            <div className="p-8 text-center font-mono text-xs text-muted">
              {deferredSearch
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
                    highlight={searchResult.highlight}
                    canJumpToContext={canJumpToContext}
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
