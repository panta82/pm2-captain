import { type ReactNode } from 'react';

import { getHighlightSegments } from '@/lib/highlight';

export { buildHighlightRegex } from '@/lib/highlight';

export function highlightText(text: string, regex: RegExp): ReactNode[] {
  return getHighlightSegments(text, regex).map((segment, index) =>
    segment.isHighlighted ? (
      <mark
        key={`h-${index}`}
        className="rounded-[2px] bg-highlight px-0.5 font-semibold text-accent-ink [box-decoration-break:clone]"
      >
        {segment.text}
      </mark>
    ) : (
      segment.text
    )
  );
}

export function Highlighted({ text, regex }: { text: string; regex: RegExp | null }) {
  if (!regex) {
    return text;
  }

  return <>{highlightText(text, regex)}</>;
}
