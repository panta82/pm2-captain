import { type IHighlightLayer, getHighlightSegments, getSearchColorStyle } from '@/lib/highlight';
import { cn } from '@/lib/utils';

const NO_HIGHLIGHTS: readonly IHighlightLayer[] = [];

/**
 * Paint filter matches in the highlight green and each highlight term in its own color.
 */
export function Highlighted({
  text,
  regex,
  highlights = NO_HIGHLIGHTS,
}: {
  text: string;
  /** The active filter; its matches win where they overlap a highlight. */
  regex: RegExp | null;
  highlights?: readonly IHighlightLayer[];
}) {
  if (!regex && !highlights.length) {
    return text;
  }

  const firstHighlightLayer = regex ? 1 : 0;
  const regexes = highlights.map(highlight => highlight.regex);
  return (
    <>
      {getHighlightSegments(text, regex ? [regex, ...regexes] : regexes).map((segment, index) => {
        if (segment.layer === null) {
          return segment.text;
        }
        const highlight =
          segment.layer >= firstHighlightLayer
            ? highlights[segment.layer - firstHighlightLayer]
            : null;
        return (
          <mark
            key={`h-${index}`}
            className={cn(
              'rounded-[2px] px-0.5 font-semibold text-accent-ink [box-decoration-break:clone]',
              highlight ? 'bg-(--mark)' : 'bg-highlight'
            )}
            style={highlight ? getSearchColorStyle(highlight.color) : undefined}
          >
            {segment.text}
          </mark>
        );
      })}
    </>
  );
}
