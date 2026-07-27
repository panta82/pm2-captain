export type IHighlightSegment = {
  text: string;
  isHighlighted: boolean;
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

export function getHighlightSegments(text: string, regex: RegExp): IHighlightSegment[] {
  regex.lastIndex = 0;
  const segments: IHighlightSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index), isHighlighted: false });
      cursor = match.index;
    }

    const matched = match[0];
    if (matched.length === 0) {
      if (regex.lastIndex === match.index) {
        regex.lastIndex += 1;
      }
      continue;
    }

    segments.push({ text: matched, isHighlighted: true });
    cursor = regex.lastIndex;

    if (!regex.global) {
      break;
    }
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), isHighlighted: false });
  }

  return segments.length > 0 ? segments : [{ text, isHighlighted: false }];
}
