import { focusProcessList } from '@/lib/keyboard_shortcuts';
import { useProcessListFilter } from '@/lib/process_list_filter';
import { cn } from '@/lib/utils';

import { SearchFilter } from './search_filter';

export function ProcessFilterField({ className }: { className?: string }) {
  const filter = useProcessListFilter();

  return (
    <SearchFilter
      draft={filter.search}
      onDraftChange={filter.setSearch}
      caseSensitive={filter.caseSensitive}
      onCaseSensitiveChange={filter.setCaseSensitive}
      regex={filter.regex}
      onRegexChange={filter.setRegex}
      findStep={1}
      // Type, then go on to the processes that are left.
      onGoToList={focusProcessList}
      onLeave={focusProcessList}
      placeholder="Filter processes…"
      className={cn('w-full max-w-none sm:w-full', className)}
    />
  );
}
