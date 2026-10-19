import { CaseSensitive, Funnel, Loader2, Regex, Search, X } from 'lucide-react';
import { useRef } from 'react';

import type { IDebouncePhase } from '@/lib/debounce';
import { useShortcutAria, useShortcutHintsVisible } from '@/lib/keyboard_shortcuts';
import { nextFindTarget, previousFindTarget } from '@/lib/page_find';
import { cn } from '@/lib/utils';

import { ShortcutHint } from '@/components/shortcut_hint';
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
  findStep,
  onGoToList,
  onLeave,
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
  /** Its place in the Ctrl+F order (FIND_TARGET_ATTRIBUTE). Omit for a box Ctrl+F skips. */
  findStep?: number;
  /** Down or Enter in the box: on to the list it filters. */
  onGoToList?: () => void;
  /** Escape in an empty box. Without it, the box only loses the focus. */
  onLeave?: () => void;
  placeholder: string;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const findShortcut = useShortcutAria('find');
  // Hints mark only the boxes that Ctrl+F and Ctrl+Shift+F would go to now.
  const areHintsVisible = useShortcutHintsVisible();
  let findHint: 'find' | 'find.back' | null = null;
  if (areHintsVisible && findStep !== undefined && inputRef.current) {
    if (nextFindTarget() === inputRef.current) {
      findHint = 'find';
    } else if (previousFindTarget() === inputRef.current) {
      findHint = 'find.back';
    }
  }

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
          ref={inputRef}
          value={draft}
          // Ctrl+F finds its box by this attribute (FIND_TARGET_ATTRIBUTE).
          data-find-target={findStep}
          aria-keyshortcuts={findStep === undefined ? undefined : findShortcut}
          onChange={event => onDraftChange(event.target.value)}
          onKeyDown={event => {
            const hasModifier = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
            if (
              (event.key === 'ArrowDown' || event.key === 'Enter') &&
              onGoToList &&
              !hasModifier
            ) {
              event.preventDefault();
              onGoToList();
            } else if (event.key === 'Escape') {
              // The first Escape clears the box, the next one leaves it.
              if (draft) {
                event.preventDefault();
                onDraftChange('');
              } else if (onLeave) {
                event.preventDefault();
                onLeave();
              } else {
                event.currentTarget.blur();
              }
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
        {findHint ? (
          <ShortcutHint action={findHint} className="top-1/2 right-1.5 -translate-y-1/2" />
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
