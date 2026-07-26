import { useParams } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CaseSensitive, Pause, Play, Regex, Search, TextWrap } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { trpc } from '@/lib/trpc';
import { cn, formatTimestamp } from '@/lib/utils';

import { Button, ToggleGroup } from '@/components/ui';

import type { ILogEntry, ILogView } from '@shared/contracts';

const MAX_LOADED_LINES = 20_000;
const MAX_PAUSED_LINES = 5_000;

/**
 * Set first letter in a string to uppercase. Doesn't touch other chars.
 */
export function capitalize<T extends string>(str: T): Capitalize<T> {
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
  const [search, setSearch] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  const bufferRef = useRef<ILogEntry[]>([]);
  const isFollowingRef = useRef(true);
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
      return { entries, error: '' };
    }
    try {
      const matcher = regex ? new RegExp(search, caseSensitive ? '' : 'i') : null;
      const needle = caseSensitive ? search : search.toLowerCase();
      return {
        entries: entries.filter(entry =>
          matcher
            ? matcher.test(entry.text)
            : (caseSensitive ? entry.text : entry.text.toLowerCase()).includes(needle)
        ),
        error: '',
      };
    } catch (error) {
      return {
        entries,
        error: error instanceof Error ? error.message : 'Invalid expression',
      };
    }
  }, [caseSensitive, entries, regex, search]);

  const virtualizer = useVirtualizer({
    count: searchResult.entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (wrap ? 28 : 24),
    overscan: 20,
    useFlushSync: false,
  });
  const totalSize = virtualizer.getTotalSize();

  // Keep pinned to bottom after React/virtualizer layout when following.
  useLayoutEffect(() => {
    pinToBottom();
  }, [pinToBottom, searchResult.entries.length, totalSize]);

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
                className="h-8 rounded-md px-3 font-mono text-xs"
                onClick={() => setView(option)}
              >
                {option === 'combined' ? 'All' : capitalize(option)}
              </Button>
            ))}
          </ToggleGroup>
        </div>

        <div className="flex min-w-0 items-center justify-center gap-2">
          <div className="relative min-w-0 w-full max-w-md sm:w-[min(28rem,40vw)]">
            <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="search loaded logs…"
              className="h-9 w-full rounded-lg border border-line bg-panel pl-9 pr-20 font-mono text-xs text-white outline-none placeholder:text-muted/70 focus:border-cyan/60"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] text-muted">
              {search ? `${searchResult.entries.length}/${entries.length}` : entries.length}
            </span>
          </div>
          <Button
            variant="toggle"
            aria-label="Case sensitive"
            aria-pressed={caseSensitive}
            className="size-9 shrink-0 p-0"
            title="Case sensitive"
            onClick={() => setCaseSensitive(value => !value)}
          >
            <CaseSensitive className="size-4" />
          </Button>
          <Button
            variant="toggle"
            aria-label="Regular expression"
            aria-pressed={regex}
            className="size-9 shrink-0 p-0"
            title="Regular expression"
            onClick={() => setRegex(value => !value)}
          >
            <Regex className="size-4" />
          </Button>
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

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto border-t border-line bg-[#041522]"
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
        ) : !searchResult.entries.length ? (
          <div className="p-8 text-center font-mono text-xs text-muted">
            {search ? 'No loaded lines match the search.' : 'No log lines in the active file yet.'}
          </div>
        ) : (
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map(virtualRow => {
              const entry = searchResult.entries[virtualRow.index];
              return (
                <div
                  key={entry.id}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  className={cn(
                    'absolute left-0 top-0 grid w-full grid-cols-[4px_104px_minmax(0,1fr)] gap-3 px-5 py-1 font-mono text-[12px] leading-5',
                    entry.channel === 'err' && 'bg-danger/5'
                  )}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <i
                    className={cn(
                      'h-full min-h-5 rounded-full',
                      entry.channel === 'err' ? 'bg-danger' : 'bg-[#31516a]'
                    )}
                  />
                  <span className="select-none text-muted">{formatTimestamp(entry.timestamp)}</span>
                  <span
                    className={cn(
                      'text-[#d8e8f5]',
                      entry.channel === 'err' && 'text-[#ff8c9e]',
                      wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
                    )}
                  >
                    {entry.text}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
