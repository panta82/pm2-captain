import { CaseSensitive, Funnel, Loader2, Regex, Search, X } from 'lucide-react';

import type { IDebouncePhase } from '@/lib/debounce';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui';

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

const TOGGLE_CLASS =
  'h-full w-9 shrink-0 rounded-none border-0 border-l border-line p-0 shadow-none last:rounded-r-[7px] focus-visible:outline-offset-[-2px] active:translate-y-0 aria-pressed:translate-y-0';

export function SearchFilter({
  draft,
  phase = 'idle',
  onDraftChange,
  caseSensitive,
  onCaseSensitiveChange,
  regex,
  onRegexChange,
  isFilter,
  onIsFilterChange,
  hasSearchIcon = true,
  placeholder,
  className,
}: {
  draft: string;
  /** Omit for a filter that applies immediately. */
  phase?: IDebouncePhase;
  onDraftChange: (next: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (next: boolean) => void;
  regex: boolean;
  onRegexChange: (next: boolean) => void;
  /** Hide the lines without a match, or only highlight the matches. */
  isFilter?: boolean;
  /** Omit where a box always filters. */
  onIsFilterChange?: (next: boolean) => void;
  hasSearchIcon?: boolean;
  placeholder: string;
  className?: string;
}) {
  return (
    <div
      data-component="SearchFilter"
      className={cn(
        'flex h-9 min-w-0 w-full max-w-md items-stretch overflow-hidden rounded-lg border border-line bg-input has-[input:focus]:border-cyan/60 has-[input:focus]:bg-input-focus sm:w-[min(28rem,40vw)]',
        className
      )}
    >
      <div className="relative min-h-0 min-w-0 flex-1 self-stretch">
        {hasSearchIcon ? (
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
        ) : null}
        <input
          value={draft}
          onChange={event => onDraftChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape' && draft) {
              event.preventDefault();
              onDraftChange('');
            }
          }}
          placeholder={placeholder}
          className={cn(
            'block h-full w-full border-0 bg-transparent py-0 font-mono text-xs leading-none text-white outline-none placeholder:text-muted/70',
            hasSearchIcon ? 'pl-9' : 'pl-3',
            draft || phase !== 'idle' ? 'pr-9' : 'pr-3'
          )}
        />
        {phase === 'debouncing' ? (
          <span
            className="pointer-events-none absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center text-white"
            aria-hidden
          >
            <TypingDots className="size-3.5" />
          </span>
        ) : phase === 'resolving' ? (
          <span
            className="pointer-events-none absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center text-white"
            aria-label="Filtering"
          >
            <Loader2 className="size-3.5 animate-spin" />
          </span>
        ) : draft ? (
          <button
            type="button"
            aria-label="Clear filter"
            title="Clear filter"
            className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded text-white hover:bg-white/10"
            onClick={() => onDraftChange('')}
          >
            <X className="size-3.5" strokeWidth={2.5} />
          </button>
        ) : null}
      </div>
      <Button
        variant="toggle"
        aria-label="Case sensitive"
        aria-pressed={caseSensitive}
        className={TOGGLE_CLASS}
        title="Case sensitive"
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
      >
        <CaseSensitive className="size-4" />
      </Button>
      <Button
        variant="toggle"
        aria-label="Regular expression"
        aria-pressed={regex}
        className={TOGGLE_CLASS}
        title="Regular expression"
        onClick={() => onRegexChange(!regex)}
      >
        <Regex className="size-4" />
      </Button>
      {onIsFilterChange ? (
        <Button
          variant="toggle"
          aria-label="Filter lines"
          aria-pressed={isFilter}
          className={TOGGLE_CLASS}
          title={
            isFilter
              ? 'Filtering: only matching lines are shown'
              : 'Highlighting: every line is shown'
          }
          onClick={() => onIsFilterChange(!isFilter)}
        >
          <Funnel className="size-4" fill={isFilter ? 'currentColor' : 'none'} fillOpacity={0.35} />
        </Button>
      ) : null}
    </div>
  );
}
