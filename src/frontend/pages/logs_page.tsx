import { useParams } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  CaseSensitive,
  Download,
  Loader2,
  Pause,
  Play,
  Regex,
  Search,
  TextWrap,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useDebouncedSearch } from '@/lib/debounce';
import { trpc } from '@/lib/trpc';
import { cn, formatTimestamp } from '@/lib/utils';

import { Highlighted, buildHighlightRegex } from '@/components/highlighted';
import { Button, ToggleGroup } from '@/components/ui';

import type { ILogEntry, ILogView } from '@shared/contracts';

const MAX_LOADED_LINES = 20_000;
const MAX_PAUSED_LINES = 5_000;
const SEARCH_DEBOUNCE_MS = 300; // quiet period before applying filter

function TypingDots({ className }: { className?: string }) {
  return (
    <svg
      data-component="TypingDots"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={cn('typing-dots fill-current', className)}
      aria-hidden
    >
      <ellipse cx="4" cy="12" rx="2.5" ry="2.5" />
      <ellipse cx="12" cy="12" rx="2.5" ry="2.5" />
      <ellipse cx="20" cy="12" rx="2.5" ry="2.5" />
    </svg>
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

export function LogsPage() {
  const { pmId } = useParams({ from: '/processes/$pmId' });
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
  }, [numericId, view]);

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
    { pmId: numericId, view },
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
  }, [cursor, hasMore, loadingOlder, numericId, utils.client.logs.page, view]);

  const searchResult = useMemo(() => {
    if (!search) {
      return { entries, error: '', highlight: null as RegExp | null };
    }
    try {
      const highlight = buildHighlightRegex(search, { caseSensitive, regex });
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
  }, [caseSensitive, entries, regex, search]);

  const filteredEntries = searchResult.entries;
  const canJumpToContext = Boolean(search);

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
    anchor.download = `pm2-${numericId}-${view}${search ? '-filtered' : ''}-${stamp}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [filteredEntries, numericId, search, view]);

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
  }, [pinToBottom, filteredEntries.length, totalSize, wrap, search]);

  // After clearing a filter, scroll the chosen line into full-context view.
  useLayoutEffect(() => {
    const entryId = pendingJumpIdRef.current;
    if (!entryId || search) {
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
  }, [entries, search, virtualizer, wrap]);

  useEffect(() => {
    if (!focusedEntryId) {
      return;
    }
    const timer = window.setTimeout(() => setFocusedEntryId(null), 2_500);
    return () => window.clearTimeout(timer);
  }, [focusedEntryId]);

  const renderTimestamp = (entry: ILogEntry) => {
    const label = formatTimestamp(entry.timestamp);
    if (!canJumpToContext) {
      return <span className="select-none text-muted">{label}</span>;
    }
    return (
      <button
        type="button"
        className="select-none text-left text-muted underline-offset-2 hover:text-cyan hover:underline"
        title="Clear filter and show surrounding log context"
        onClick={() => revealLogEntry(entry.id)}
      >
        {label}
      </button>
    );
  };

  return (
    <div data-component="LogsPage" className="flex min-h-0 flex-1 flex-col bg-topbar">
      <div className="grid shrink-0 grid-cols-1 items-center gap-2 border-b border-line bg-panel/30 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:px-7">
        <div className="flex justify-start">
          <ToggleGroup aria-label="Log stream filter">
            {(['combined', 'out', 'err'] as const).map(option => (
              <Button
                key={option}
                variant="toggle"
                aria-pressed={view === option}
                className="h-8 px-3 font-mono text-xs"
                onClick={() => setView(option)}
              >
                {option === 'combined' ? 'All' : capitalize(option)}
              </Button>
            ))}
          </ToggleGroup>
        </div>

        <div className="flex min-w-0 items-center justify-center">
          <div className="flex h-9 min-w-0 w-full max-w-md items-stretch overflow-hidden rounded-lg border border-line bg-panel has-[input:focus]:border-cyan/60 sm:w-[min(28rem,40vw)]">
            <div className="relative min-h-0 min-w-0 flex-1 self-stretch">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
              <input
                value={searchDraft}
                onChange={event => setSearchDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape' && searchDraft) {
                    event.preventDefault();
                    setSearchDraft('');
                  }
                }}
                placeholder="Filter loaded logs…"
                className={cn(
                  'block h-full w-full border-0 bg-transparent py-0 pl-9 font-mono text-xs leading-none text-white outline-none placeholder:text-muted/70',
                  searchDraft || searchPhase !== 'idle' ? 'pr-9' : 'pr-3'
                )}
              />
              {searchPhase === 'debouncing' ? (
                <span
                  className="pointer-events-none absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center text-white"
                  aria-hidden
                >
                  <TypingDots className="size-3.5" />
                </span>
              ) : searchPhase === 'resolving' ? (
                <span
                  className="pointer-events-none absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center text-white"
                  aria-label="Filtering"
                >
                  <Loader2 className="size-3.5 animate-spin" />
                </span>
              ) : searchDraft ? (
                <button
                  type="button"
                  aria-label="Clear filter"
                  title="Clear filter"
                  className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded text-white hover:bg-white/10"
                  onClick={() => setSearchDraft('')}
                >
                  <X className="size-3.5" strokeWidth={2.5} />
                </button>
              ) : null}
            </div>
            <Button
              variant="toggle"
              aria-label="Case sensitive"
              aria-pressed={caseSensitive}
              className="h-full w-9 shrink-0 rounded-none border-0 border-l border-line p-0 shadow-none focus-visible:outline-offset-[-2px] active:translate-y-0 aria-pressed:translate-y-0"
              title="Case sensitive"
              onClick={() => setCaseSensitive(value => !value)}
            >
              <CaseSensitive className="size-4" />
            </Button>
            <Button
              variant="toggle"
              aria-label="Regular expression"
              aria-pressed={regex}
              className="h-full w-9 shrink-0 rounded-none rounded-tr-[7px] rounded-br-[7px] border-0 border-l border-line p-0 shadow-none focus-visible:outline-offset-[-2px] active:translate-y-0 aria-pressed:translate-y-0"
              title="Regular expression"
              onClick={() => setRegex(value => !value)}
            >
              <Regex className="size-4" />
            </Button>
          </div>
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
                'w-[6.5rem]',
                paused &&
                  'aria-pressed:border-warning/50 aria-pressed:bg-warning/15 aria-pressed:text-warning aria-pressed:shadow-[inset_0_2px_4px_rgb(0_0_0_/_0.32),inset_0_0_0_1px_rgb(246_183_0_/_0.55)] aria-pressed:hover:bg-warning/25'
              )}
              onClick={() => (paused ? resume() : setPaused(true))}
            >
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
              {paused ? 'Resume' : 'Pause'}
            </Button>
            {paused && bufferedCount > 0 ? (
              <span className="pointer-events-none absolute -right-1.5 -top-1.5 z-10 min-w-5 rounded-full border border-warning/50 bg-warning px-1.5 py-0.5 text-center font-mono text-[10px] font-bold leading-none text-navy">
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

      <div className="relative min-h-0 flex-1 border-t border-line bg-[#041522]">
        <div className="absolute top-2 right-2 z-10 flex h-8 items-stretch overflow-hidden rounded-lg border border-line/80 bg-topbar/90 shadow-lg backdrop-blur-sm">
          <span
            className="inline-flex min-w-8 items-center justify-center px-2.5 font-mono text-[11px] text-muted"
            title={search ? 'Filtered / loaded lines' : 'Loaded lines'}
          >
            {search ? `${searchResult.entries.length}/${entries.length}` : entries.length}
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
              {search
                ? 'No loaded lines match the search.'
                : 'No log lines in the active file yet.'}
            </div>
          ) : wrap ? (
            <div className="w-full">
              {filteredEntries.map(entry => (
                <div
                  key={entry.id}
                  data-entry-id={entry.id}
                  className={cn(
                    'grid w-full grid-cols-[4px_104px_minmax(0,1fr)] gap-3 px-5 py-1 font-mono text-[12px] leading-5',
                    entry.channel === 'err' && 'bg-danger/5',
                    focusedEntryId === entry.id && 'bg-cyan/10 ring-1 ring-inset ring-cyan/40'
                  )}
                >
                  <i
                    className={cn(
                      'h-full min-h-5 rounded-full',
                      entry.channel === 'err' ? 'bg-danger' : 'bg-[#31516a]'
                    )}
                  />
                  {renderTimestamp(entry)}
                  <span
                    className={cn(
                      'whitespace-pre-wrap break-words text-[#d8e8f5]',
                      entry.channel === 'err' && 'text-[#ff8c9e]'
                    )}
                  >
                    <Highlighted text={entry.text} regex={searchResult.highlight} />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="relative w-full" style={{ height: `${totalSize}px` }}>
              {virtualizer.getVirtualItems().map(virtualRow => {
                const entry = filteredEntries[virtualRow.index];
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    data-entry-id={entry.id}
                    className={cn(
                      'absolute top-0 left-0 grid w-full grid-cols-[4px_104px_minmax(0,1fr)] gap-3 px-5 py-1 font-mono text-[12px] leading-5',
                      entry.channel === 'err' && 'bg-danger/5',
                      focusedEntryId === entry.id && 'bg-cyan/10 ring-1 ring-inset ring-cyan/40'
                    )}
                    style={{
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <i
                      className={cn(
                        'h-full min-h-5 rounded-full',
                        entry.channel === 'err' ? 'bg-danger' : 'bg-[#31516a]'
                      )}
                    />
                    {renderTimestamp(entry)}
                    <span
                      className={cn(
                        'whitespace-pre text-[#d8e8f5]',
                        entry.channel === 'err' && 'text-[#ff8c9e]'
                      )}
                    >
                      <Highlighted text={entry.text} regex={searchResult.highlight} />
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
