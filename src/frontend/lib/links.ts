/** A web address found in text, by character offsets. */
export type ITextLink = {
  start: number;
  end: number;
  url: string;
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
