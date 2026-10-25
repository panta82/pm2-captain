import { Fragment } from 'react';

import {
  type IHighlightLayer,
  type IHighlightSegment,
  getHighlightSegments,
  getSearchColorStyle,
} from '@/lib/highlight';
import { findLinks, groupSegmentsByLink } from '@/lib/links';
import { cn } from '@/lib/utils';

const NO_HIGHLIGHTS: readonly IHighlightLayer[] = [];

/**
 * Paint filter matches in the highlight green and each highlight term in its own color.
 * With `hasLinks`, web addresses in the text also become links.
 */
export function Highlighted({
  text,
  regex,
  highlights = NO_HIGHLIGHTS,
  hasLinks = false,
}: {
  text: string;
  /** The active filter; its matches win where they overlap a highlight. */
  regex: RegExp | null;
  highlights?: readonly IHighlightLayer[];
  hasLinks?: boolean;
}) {
  const links = hasLinks ? findLinks(text) : [];
  if (!regex && !highlights.length && !links.length) {
    return text;
  }

  const firstHighlightLayer = regex ? 1 : 0;
  const regexes = highlights.map(highlight => highlight.regex);
  const renderSegment = (segment: IHighlightSegment, key: string) => {
    if (segment.layer === null) {
      return segment.text;
    }
    const highlight =
      segment.layer >= firstHighlightLayer ? highlights[segment.layer - firstHighlightLayer] : null;
    return (
      <mark
        key={key}
        className={cn(
          'rounded-[2px] px-0.5 font-semibold text-accent-ink [box-decoration-break:clone]',
          highlight ? 'bg-(--mark)' : 'bg-highlight'
        )}
        style={highlight ? getSearchColorStyle(highlight.color) : undefined}
      >
        {segment.text}
      </mark>
    );
  };
  const segments = getHighlightSegments(text, regex ? [regex, ...regexes] : regexes);
  if (!links.length) {
    return <>{segments.map((segment, index) => renderSegment(segment, `h-${index}`))}</>;
  }

  return (
    <>
      {groupSegmentsByLink(segments, links).map(({ link, segments: linkSegments }, groupIndex) => {
        const content = linkSegments.map((segment, index) =>
          renderSegment(segment, `h-${groupIndex}-${index}`)
        );
        return link ? (
          // Out of the tab order, which would otherwise step through every link
          // on screen; not draggable, so a drag that starts on it selects text.
          <a
            key={`l-${groupIndex}`}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            tabIndex={-1}
            draggable={false}
            className="underline underline-offset-2 hover:text-cyan"
          >
            {content}
          </a>
        ) : (
          <Fragment key={`t-${groupIndex}`}>{content}</Fragment>
        );
      })}
    </>
  );
}
