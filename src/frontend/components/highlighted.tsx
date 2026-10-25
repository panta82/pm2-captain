import { Fragment } from 'react';

import { type IAnsiRun, getAnsiStyle } from '@/lib/ansi';
import {
  type IHighlightLayer,
  type IHighlightSegment,
  getHighlightSegments,
  getSearchColorStyle,
} from '@/lib/highlight';
import { findLinks } from '@/lib/links';
import { groupConsecutive, splitRichText } from '@/lib/rich_text';
import { cn } from '@/lib/utils';

const NO_HIGHLIGHTS: readonly IHighlightLayer[] = [];
const NO_STYLES: readonly IAnsiRun[] = [];

/**
 * Paint filter matches in the highlight green and each highlight term in its own color.
 * With `hasLinks`, web addresses in the text also become links; `styles` color
 * the text as a terminal would.
 */
export function Highlighted({
  text,
  regex,
  highlights = NO_HIGHLIGHTS,
  hasLinks = false,
  styles = NO_STYLES,
}: {
  text: string;
  /** The active filter; its matches win where they overlap a highlight. */
  regex: RegExp | null;
  highlights?: readonly IHighlightLayer[];
  hasLinks?: boolean;
  /** Styled runs of the text, from the escape codes `parseAnsi` took out of it. */
  styles?: readonly IAnsiRun[];
}) {
  const links = hasLinks ? findLinks(text) : [];
  if (!regex && !highlights.length && !links.length && !styles.length) {
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
    // A mark takes no more room than its text, so the line does not move as a
    // search is typed: no side padding, and a text shadow stands in for bold,
    // which is wider in proportional fonts.
    return (
      <mark
        key={key}
        className={cn(
          'rounded-[2px] text-accent-ink [box-decoration-break:clone] [text-shadow:0.3px_0_0_currentColor,-0.3px_0_0_currentColor]',
          highlight ? 'bg-(--mark)' : 'bg-highlight'
        )}
        style={highlight ? getSearchColorStyle(highlight.color) : undefined}
      >
        {segment.text}
      </mark>
    );
  };
  const segments = getHighlightSegments(text, regex ? [regex, ...regexes] : regexes);
  const pieces = splitRichText(segments, links, styles);

  // Links hold styled runs, which hold marks. A mark keeps its own colors in
  // a colored run, so it reads the same everywhere.
  return (
    <>
      {groupConsecutive(pieces, piece => piece.link).map(({ key: link, items }, linkIndex) => {
        const content = groupConsecutive(items, piece => piece.style).map(
          ({ key: style, items: styled }, styleIndex) => {
            const key = `${linkIndex}-${styleIndex}`;
            const marks = styled.map((piece, index) => renderSegment(piece, `h-${key}-${index}`));
            return style ? (
              <span key={`s-${key}`} style={getAnsiStyle(style)}>
                {marks}
              </span>
            ) : (
              <Fragment key={`t-${key}`}>{marks}</Fragment>
            );
          }
        );
        return link ? (
          // Out of the tab order, which would otherwise step through every link
          // on screen; not draggable, so a drag that starts on it selects text.
          <a
            key={`l-${linkIndex}`}
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
          <Fragment key={`u-${linkIndex}`}>{content}</Fragment>
        );
      })}
    </>
  );
}
