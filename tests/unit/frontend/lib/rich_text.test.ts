import { describe, expect, it } from 'vitest';

import { parseAnsi } from '../../../../src/frontend/lib/ansi';
import { buildHighlightRegex, getHighlightSegments } from '../../../../src/frontend/lib/highlight';
import { findLinks } from '../../../../src/frontend/lib/links';
import { groupConsecutive, splitRichText } from '../../../../src/frontend/lib/rich_text';

const plain = (search: string) =>
  buildHighlightRegex(search, { caseSensitive: false, regex: false });

describe('splitRichText', () => {
  it('cuts a match that crosses the edge of a link', () => {
    const text = 'see: https://x.io/a now';
    const pieces = splitRichText(
      getHighlightSegments(text, [plain('see: https')]),
      findLinks(text),
      []
    );

    expect(pieces.map(piece => [piece.text, piece.layer, piece.link?.url ?? null])).toEqual([
      ['see: ', 0, null],
      ['https', 0, 'https://x.io/a'],
      ['://x.io/a', null, 'https://x.io/a'],
      [' now', null, null],
    ]);
  });

  it('cuts at the edges of styled runs, inside and outside links', () => {
    const { text, runs } = parseAnsi('go \x1b[36mhttps://x.io/\x1b[1ma\x1b[0m now');
    const pieces = splitRichText(getHighlightSegments(text, [plain('a n')]), findLinks(text), runs);

    expect(text).toBe('go https://x.io/a now');
    expect(
      pieces.map(piece => [
        piece.text,
        piece.layer,
        Boolean(piece.link),
        piece.style?.isBold ?? null,
      ])
    ).toEqual([
      ['go ', null, false, null],
      ['https://x.io/', null, true, false],
      ['a', 0, true, true],
      [' n', 0, false, null],
      ['ow', null, false, null],
    ]);
  });
});

describe('groupConsecutive', () => {
  it('keeps neighbors with the same key together, and apart from equal keys further on', () => {
    expect(groupConsecutive(['a', 'b', 'C', 'd'], item => item === item.toLowerCase())).toEqual([
      { key: true, items: ['a', 'b'] },
      { key: false, items: ['C'] },
      { key: true, items: ['d'] },
    ]);
  });
});
