import type { IAnsiRun, IAnsiStyle } from '@/lib/ansi';
import type { IHighlightSegment } from '@/lib/highlight';
import type { ITextLink } from '@/lib/links';

/** A piece of text with the same search mark, link and terminal style throughout. */
export type IRichTextPiece = IHighlightSegment & {
  link: ITextLink | null;
  style: IAnsiStyle | null;
};

/** Steps through sorted ranges that do not overlap, for positions that only grow. */
function rangeWalker<T extends { start: number; end: number }>(ranges: readonly T[]) {
  let index = 0;
  return (position: number) => {
    while (index < ranges.length && ranges[index].end <= position) {
      index += 1;
    }
    const next = ranges[index];
    const current = next && next.start <= position ? next : null;
    /** Where the range at the position ends, or the next one starts. */
    const edge = current ? current.end : (next?.start ?? Infinity);
    return { current, edge };
  };
}

/**
 * Cuts the highlight segments of a text wherever a link or a terminal style
 * starts or ends, so that a search match can cross either edge.
 */
export function splitRichText(
  segments: readonly IHighlightSegment[],
  links: readonly ITextLink[],
  runs: readonly IAnsiRun[]
): IRichTextPiece[] {
  const linkAt = rangeWalker(links);
  const runAt = rangeWalker(runs);
  const pieces: IRichTextPiece[] = [];
  let offset = 0;
  for (const segment of segments) {
    const segmentEnd = offset + segment.text.length;
    let position = offset;
    while (position < segmentEnd) {
      const link = linkAt(position);
      const run = runAt(position);
      const end = Math.min(segmentEnd, link.edge, run.edge);
      pieces.push({
        text: segment.text.slice(position - offset, end - offset),
        layer: segment.layer,
        link: link.current,
        style: run.current?.style ?? null,
      });
      position = end;
    }
    offset = segmentEnd;
  }
  return pieces;
}

/** Groups neighboring items that share a key, keeping their order. */
export function groupConsecutive<T, K>(
  items: readonly T[],
  keyOf: (item: T) => K
): { key: K; items: T[] }[] {
  const groups: { key: K; items: T[] }[] = [];
  for (const item of items) {
    const key = keyOf(item);
    const last = groups.at(-1);
    if (last && last.key === key) {
      last.items.push(item);
    } else {
      groups.push({ key, items: [item] });
    }
  }
  return groups;
}
