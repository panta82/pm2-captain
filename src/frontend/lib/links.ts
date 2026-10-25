import type { IHighlightSegment } from '@/lib/highlight';

/** A web address found in text, by character offsets. */
export type ITextLink = {
  start: number;
  end: number;
  url: string;
};

/** A run of highlight segments that all lie inside one link, or outside any. */
export type ILinkedSegments = {
  link: ITextLink | null;
  segments: IHighlightSegment[];
};

// A link runs up to whitespace, a quote, an angle bracket or a control
// character, which stops it at the escape code that ends a colored span. It may
// start right after a word, as after the "\x1b[36m" that starts one.
const LINK_PATTERN = /https?:\/\/[^\s<>"'`\x00-\x1f\x7f]+/gi;
const TRAILING_PUNCTUATION = '.,;:!?';
const OPENING_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function countOf(text: string, character: string) {
  return text.split(character).length - 1;
}

/**
 * Drops what usually belongs to the sentence around a link: trailing punctuation,
 * and closing brackets the link itself did not open, as in "(see https://x.io/a)."
 */
function trimLinkEnd(candidate: string) {
  let end = candidate.length;
  while (end > 0) {
    const last = candidate[end - 1];
    const opening = OPENING_BRACKETS[last];
    const isTrailing = TRAILING_PUNCTUATION.includes(last);
    const isUnbalanced =
      opening !== undefined &&
      countOf(candidate.slice(0, end), last) > countOf(candidate.slice(0, end), opening);
    if (!isTrailing && !isUnbalanced) {
      break;
    }
    end -= 1;
  }
  return candidate.slice(0, end);
}

/** Finds the http and https addresses in a line of text. */
export function findLinks(text: string): ITextLink[] {
  if (!text.includes('://')) {
    return [];
  }
  const links: ITextLink[] = [];
  for (const match of text.matchAll(LINK_PATTERN)) {
    const url = trimLinkEnd(match[0]);
    if (URL.canParse(url)) {
      links.push({ start: match.index, end: match.index + url.length, url });
    }
  }
  return links;
}

/**
 * Groups highlight segments by the link they lie in. A segment that crosses
 * a link's edge is cut there, so a search match can start before a link and
 * end inside it.
 */
export function groupSegmentsByLink(
  segments: readonly IHighlightSegment[],
  links: readonly ITextLink[]
): ILinkedSegments[] {
  const groups: ILinkedSegments[] = [];
  let offset = 0;
  let linkIndex = 0;
  for (const segment of segments) {
    let start = 0;
    while (start < segment.text.length) {
      const position = offset + start;
      while (linkIndex < links.length && links[linkIndex].end <= position) {
        linkIndex += 1;
      }
      const next = links[linkIndex];
      const link = next && next.start <= position ? next : null;
      const boundary = link ? link.end : (next?.start ?? Infinity);
      const end = Math.min(segment.text.length, boundary - offset);
      const piece = { text: segment.text.slice(start, end), layer: segment.layer };
      const last = groups.at(-1);
      if (last && last.link === link) {
        last.segments.push(piece);
      } else {
        groups.push({ link, segments: [piece] });
      }
      start = end;
    }
    offset += segment.text.length;
  }
  return groups;
}
