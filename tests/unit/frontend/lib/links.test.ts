import { describe, expect, it } from 'vitest';

import { findLinks } from '../../../../src/frontend/lib/links';

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
