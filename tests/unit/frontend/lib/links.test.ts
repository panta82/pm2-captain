import { describe, expect, it } from 'vitest';

import { buildHighlightRegex, getHighlightSegments } from '../../../../src/frontend/lib/highlight';
import { findLinks, groupSegmentsByLink } from '../../../../src/frontend/lib/links';

const urlsIn = (text: string) => findLinks(text).map(link => link.url);

describe('findLinks', () => {
  it('finds http and https addresses with their offsets', () => {
    const text = 'For help, see: https://nodejs.org/en/docs/inspector';
    expect(findLinks(text)).toEqual([
      { start: 15, end: text.length, url: 'https://nodejs.org/en/docs/inspector' },
    ]);
    expect(urlsIn('Listening on http://localhost:3000/ and HTTP://[::1]:8080')).toEqual([
      'http://localhost:3000/',
      'HTTP://[::1]:8080',
    ]);
  });

  it('leaves out the punctuation and brackets around a link', () => {
    expect(urlsIn('Docs: https://x.io/a.')).toEqual(['https://x.io/a']);
    expect(urlsIn('(see https://x.io/a), then "https://x.io/b"')).toEqual([
      'https://x.io/a',
      'https://x.io/b',
    ]);
    expect(urlsIn('<https://x.io/a>; [https://x.io/b]')).toEqual([
      'https://x.io/a',
      'https://x.io/b',
    ]);
  });

  it('keeps brackets the link opened itself', () => {
    expect(urlsIn('https://en.wikipedia.org/wiki/Node_(software)')).toEqual([
      'https://en.wikipedia.org/wiki/Node_(software)',
    ]);
    expect(urlsIn('(https://en.wikipedia.org/wiki/Node_(software))')).toEqual([
      'https://en.wikipedia.org/wiki/Node_(software)',
    ]);
  });

  it('finds a link inside the escape codes of a colored span', () => {
    expect(urlsIn('\x1b[36mhttp://localhost:3000\x1b[39m ready')).toEqual([
      'http://localhost:3000',
    ]);
  });

  it('ignores other schemes, addresses without a scheme, and incomplete ones', () => {
    expect(urlsIn('ftp://x.io file:///etc/passwd javascript:alert(1) www.x.io')).toEqual([]);
    expect(urlsIn('https:// and http://...')).toEqual([]);
  });
});

describe('groupSegmentsByLink', () => {
  it('cuts a match that crosses the edge of a link', () => {
    const text = 'see: https://x.io/a now';
    const segments = getHighlightSegments(text, [
      buildHighlightRegex('see: https', { caseSensitive: false, regex: false }),
    ]);
    const groups = groupSegmentsByLink(segments, findLinks(text));

    expect(groups).toEqual([
      { link: null, segments: [{ text: 'see: ', layer: 0 }] },
      {
        link: { start: 5, end: 19, url: 'https://x.io/a' },
        segments: [
          { text: 'https', layer: 0 },
          { text: '://x.io/a', layer: null },
        ],
      },
      { link: null, segments: [{ text: ' now', layer: null }] },
    ]);
  });

  it('keeps neighboring links apart', () => {
    const text = 'https://a.io https://b.io';
    const groups = groupSegmentsByLink(getHighlightSegments(text, []), findLinks(text));

    expect(groups.map(group => [group.link?.url ?? null, group.segments])).toEqual([
      ['https://a.io', [{ text: 'https://a.io', layer: null }]],
      [null, [{ text: ' ', layer: null }]],
      ['https://b.io', [{ text: 'https://b.io', layer: null }]],
    ]);
  });
});
