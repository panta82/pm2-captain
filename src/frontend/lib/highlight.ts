import type { CSSProperties } from 'react';

export type IHighlightSegment = {
  text: string;
  /** Index of the regex that matched this text, or null for unmatched text. */
  layer: number | null;
};

/**
 * Search box colors in the order they are handed out; each names a `--color-mark-*`
 * token. The first box keeps the filter green.
 */
export const SEARCH_COLORS = [
  'green',
  'violet',
  'red',
  'orange',
  'blue',
  'yellow',
  'pink',
  'teal',
] as const;

export type ISearchColor = (typeof SEARCH_COLORS)[number];

/** One box of the log search: a term that filters lines, or only highlights its matches. */
export type ILogSearchTerm = {
  id: number;
  search: string;
  isCaseSensitive: boolean;
  isRegex: boolean;
  isFilter: boolean;
  color: ISearchColor;
};

/** A compiled term, ready to paint. */
export type IHighlightLayer = {
  regex: RegExp;
  color: ISearchColor;
};

export type ICompiledSearch = {
  /** A line is shown only when every filter matches it. */
  filters: RegExp[];
  /** Filters first, so their color wins where a highlight overlaps them. */
  layers: IHighlightLayer[];
  /** Why the first term that does not compile was left out. */
  error: string;
};

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a global regex used both to filter log lines and to paint match spans.
 */
export function buildHighlightRegex(
  search: string,
  options: { caseSensitive: boolean; regex: boolean }
): RegExp {
  const flags = options.caseSensitive ? 'g' : 'gi';
  return new RegExp(options.regex ? search : escapeRegExp(search), flags);
}

/**
 * Split text into unmatched and matched segments. Where matches of different
 * regexes overlap, the earlier regex keeps its match and the later one is skipped.
 */
export function getHighlightSegments(
  text: string,
  regexes: readonly RegExp[]
): IHighlightSegment[] {
  const ranges: { start: number; end: number; layer: number }[] = [];
  // One regex never overlaps itself, so only several layers need bookkeeping.
  const taken = regexes.length > 1 ? new Uint8Array(text.length) : null;

  regexes.forEach((regex, layer) => {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (end > start && !taken?.subarray(start, end).includes(1)) {
        taken?.fill(1, start, end);
        ranges.push({ start, end, layer });
      }
      if (!regex.global) {
        break;
      }
      // Step past an empty match, or exec() returns it forever.
      if (end === start && regex.lastIndex === start) {
        regex.lastIndex += 1;
      }
    }
  });

  ranges.sort((left, right) => left.start - right.start);
  const segments: IHighlightSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      segments.push({ text: text.slice(cursor, range.start), layer: null });
    }
    segments.push({ text: text.slice(range.start, range.end), layer: range.layer });
    cursor = range.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), layer: null });
  }

  return segments.length > 0 ? segments : [{ text, layer: null }];
}

/** The first color no box uses, so a removed box's color is handed out again first. */
export function getNextSearchColor(terms: readonly ILogSearchTerm[]): ISearchColor {
  const used = new Set(terms.map(term => term.color));
  return (
    SEARCH_COLORS.find(color => !used.has(color)) ??
    SEARCH_COLORS[terms.length % SEARCH_COLORS.length]
  );
}

/** Add an empty box after the others. It highlights until it is switched to filtering. */
export function addSearchTerm(terms: readonly ILogSearchTerm[]): ILogSearchTerm[] {
  const id = terms.reduce((max, term) => Math.max(max, term.id), 0) + 1;
  return [
    ...terms,
    {
      id,
      search: '',
      isCaseSensitive: false,
      isRegex: false,
      isFilter: false,
      color: getNextSearchColor(terms),
    },
  ];
}

/** Compile the terms that have text. A term that does not compile is left out and reported. */
export function compileSearchTerms(terms: readonly ILogSearchTerm[]): ICompiledSearch {
  const filterLayers: IHighlightLayer[] = [];
  const highlightLayers: IHighlightLayer[] = [];
  let error = '';
  for (const term of terms) {
    if (!term.search) {
      continue;
    }
    let regex: RegExp;
    try {
      regex = buildHighlightRegex(term.search, {
        caseSensitive: term.isCaseSensitive,
        regex: term.isRegex,
      });
    } catch (caught) {
      error ||= caught instanceof Error ? caught.message : 'Invalid expression';
      continue;
    }
    (term.isFilter ? filterLayers : highlightLayers).push({ regex, color: term.color });
  }
  return {
    filters: filterLayers.map(layer => layer.regex),
    layers: [...filterLayers, ...highlightLayers],
    error,
  };
}

/** Expose a search color as `--mark`, for `bg-(--mark)` and similar utilities. */
export function getSearchColorStyle(color: ISearchColor): CSSProperties {
  return { '--mark': `var(--color-mark-${color})` } as CSSProperties;
}
