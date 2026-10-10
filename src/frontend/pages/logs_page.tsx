import { useParams } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Download, Pause, Play, TextWrap } from 'lucide-react';
import {
  type CSSProperties,
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
import { trpc } from '@/lib/trpc';
import { cn, formatTimestamp } from '@/lib/utils';

import { Highlighted, buildHighlightRegex } from '@/components/highlighted';
import { SearchFilter } from '@/components/search_filter';
import { Button, ToggleGroup } from '@/components/ui';

import type { ILogEntry, ILogView } from '@shared/contracts';

const MAX_LOADED_LINES = 20_000;
const MAX_PAUSED_LINES = 5_000;
const SEARCH_DEBOUNCE_MS = 300; // quiet period before applying filter

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
  style,
  dataIndex,
}: {
  entry: ILogEntry;
  wrap: boolean;
  highlight: RegExp | null;
  canJumpToContext: boolean;
  focused: boolean;
  onReveal: (entryId: string) => void;
  style?: CSSProperties;
  dataIndex?: number;
}) {
  const timestamp = formatTimestamp(entry.timestamp);

  return (
    <div
      data-component="LogRow"
      data-index={dataIndex}
      data-entry-id={entry.id}
      className={cn(
        'grid w-full grid-cols-[4px_104px_minmax(0,1fr)] gap-3 px-5 py-1 font-mono text-[12px] leading-5',
        entry.channel === 'err' && 'bg-danger/5',
        focused && 'bg-cyan/10 ring-1 ring-inset ring-cyan/40',
        style && 'absolute top-0 left-0'
      )}
      style={style}
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
  const { daemonId, pmId } = useParams({ from: '/daemons/$daemonId/processes/$pmId' });
  const numericId = Number(pmId);
  const [view, setView] = useState<ILogView>('combined');
  const [entries, setEntries] = useState<ILogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [sharedFile, setSharedFile] = useState(false);
  const [paused, setPaused] = useState(false);
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
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  const bufferRef = useRef<ILogEntry[]>([]);
  const isFollowingRef = useRef(true);
  const pendingJumpIdRef = useRef<string | null>(null);
  const [focusedEntryId, setFocusedEntryId] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const pinToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element || !isFollowingRef.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, []);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const initialPage = trpc.logs.page.useQuery({
    daemonId,
    pmId: numericId,
    view,
    cursor: null,
    limit: 500,
  });

  useEffect(() => {
    setEntries([]);
    setCursor(null);
    setHasMore(false);
    setSharedFile(false);
    setPaused(false);
    bufferRef.current = [];
    setBufferedCount(0);
    setDropped(0);
    isFollowingRef.current = true;
  }, [daemonId, numericId, view]);

  useEffect(() => {
    if (!initialPage.data) {
      return;
    }
    isFollowingRef.current = true;
    setEntries(initialPage.data.entries);
    setCursor(initialPage.data.cursor);
    setHasMore(initialPage.data.hasMore);
    setSharedFile(initialPage.data.sharedFile);
  }, [initialPage.data]);

  trpc.logs.stream.useSubscription(
    { daemonId, pmId: numericId, view },
    {
      onData(event) {
        if (event.type === 'daemon-status') {
          if (!event.connected) {
            toast.warning(event.message || 'PM2 stream disconnected');
          }
          return;
        }
        if (!event.entry) {
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
        setEntries(current => [...current, event.entry!].slice(-MAX_LOADED_LINES));
      },
      onError(error) {
        toast.error(`Log stream: ${error.message}`);
      },
    }
  );

  const resume = () => {
    const buffered = bufferRef.current;
    bufferRef.current = [];
    setBufferedCount(0);
    setPaused(false);
    isFollowingRef.current = true;
    setEntries(current => [...current, ...buffered].slice(-MAX_LOADED_LINES));
  };

  const loadOlder = useCallback(async () => {
    if (!hasMore || !cursor || loadingOlder) {
      return;
    }
    setLoadingOlder(true);
    const element = scrollRef.current;
    const previousHeight = element?.scrollHeight || 0;
    try {
      const page = await utils.client.logs.page.query({
        daemonId,
        pmId: numericId,
        view,
        cursor,
        limit: 500,
      });
      setEntries(current => [...page.entries, ...current].slice(-MAX_LOADED_LINES));
      setCursor(page.cursor);
      setHasMore(page.hasMore);
      setSharedFile(page.sharedFile);
      if (page.rotated) {
        toast.warning('The active log file rotated; history cursor was reset.');
      }
      requestAnimationFrame(() => {
        if (element) {
          element.scrollTop = element.scrollHeight - previousHeight;
        }
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load older logs');
    } finally {
      setLoadingOlder(false);
    }
  }, [cursor, hasMore, daemonId, loadingOlder, numericId, utils.client.logs.page, view]);

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

  // Variable-height wrap rows fight virtualization (estimate/measure thrash → overlap).
  // Nowrap rows are fixed height, so virtualize only then.
  const virtualizer = useVirtualizer({
    count: filteredEntries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    overscan: 20,
    enabled: !wrap,
    getItemKey: index => filteredEntries[index]?.id ?? index,
  });
  const totalSize = virtualizer.getTotalSize();

  // Keep pinned to bottom after React/virtualizer layout when following.
  useLayoutEffect(() => {
    pinToBottom();
  }, [pinToBottom, filteredEntries.length, totalSize, wrap, deferredSearch]);

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

    if (wrap) {
      const node = scrollRef.current?.querySelector(`[data-entry-id="${CSS.escape(entryId)}"]`);
      node?.scrollIntoView({ block: 'center' });
      return;
    }
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
              className={cn(
                'h-9 w-[6.5rem] gap-1.5 px-2.5 text-xs',
                paused &&
                  'aria-pressed:border-warning/50 aria-pressed:bg-warning/15 aria-pressed:text-warning aria-pressed:shadow-[inset_0_2px_4px_rgb(0_0_0_/_0.32),inset_0_0_0_1px_rgb(246_183_0_/_0.55)] aria-pressed:hover:bg-warning/25'
              )}
              onClick={() => (paused ? resume() : setPaused(true))}
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
          className="h-full min-h-0 overflow-auto"
          onScroll={event => {
            const element = event.currentTarget;
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
          ) : wrap ? (
            <div className="w-full">
              {filteredEntries.map(entry => (
                <LogRow
                  key={entry.id}
                  entry={entry}
                  wrap
                  highlight={searchResult.highlight}
                  canJumpToContext={canJumpToContext}
                  focused={focusedEntryId === entry.id}
                  onReveal={revealLogEntry}
                />
              ))}
            </div>
          ) : (
            <div className="relative w-full" style={{ height: `${totalSize}px` }}>
              {virtualizer.getVirtualItems().map(virtualRow => {
                const entry = filteredEntries[virtualRow.index];
                return (
                  <LogRow
                    key={virtualRow.key}
                    entry={entry}
                    wrap={false}
                    highlight={searchResult.highlight}
                    canJumpToContext={canJumpToContext}
                    focused={focusedEntryId === entry.id}
                    onReveal={revealLogEntry}
                    dataIndex={virtualRow.index}
                    style={{
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
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
