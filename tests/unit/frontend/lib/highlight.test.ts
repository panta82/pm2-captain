import { describe, expect, it } from 'vitest';

import {
  type ILogSearchTerm,
  SEARCH_COLORS,
  addSearchTerm,
  buildHighlightRegex,
  compileSearchTerms,
  escapeRegExp,
  getHighlightSegments,
  getNextSearchColor,
} from '../../../../src/frontend/lib/highlight';

const plain = (search: string) =>
  buildHighlightRegex(search, { caseSensitive: false, regex: false });

/** Boxes with these searches, in order; the first filters, like the page's first box. */
function termsFor(...searches: string[]): ILogSearchTerm[] {
  const terms = searches.reduce<ILogSearchTerm[]>(current => addSearchTerm(current), []);
  return terms.map((term, index) => ({ ...term, search: searches[index], isFilter: index === 0 }));
}

describe('escapeRegExp', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegExp('a+b.*c?')).toBe('a\\+b\\.\\*c\\?');
  });
});

describe('buildHighlightRegex', () => {
  it('matches plain text case-insensitively by default', () => {
    const regex = buildHighlightRegex('Error', { caseSensitive: false, regex: false });
    expect('failed ERROR later'.match(regex)?.[0]).toBe('ERROR');
  });

  it('respects case sensitivity', () => {
    const regex = buildHighlightRegex('Error', { caseSensitive: true, regex: false });
    expect('failed ERROR later'.match(regex)).toBeNull();
    expect('failed Error later'.match(regex)?.[0]).toBe('Error');
  });

  it('compiles user regex mode', () => {
    const regex = buildHighlightRegex('err\\d+', { caseSensitive: false, regex: true });
    expect('code err42 done'.match(regex)?.[0]).toBe('err42');
  });
});

describe('getHighlightSegments', () => {
  it('splits plain matches and surrounding text', () => {
    expect(getHighlightSegments('a foo b foo', [plain('foo')])).toEqual([
      { text: 'a ', layer: null },
      { text: 'foo', layer: 0 },
      { text: ' b ', layer: null },
      { text: 'foo', layer: 0 },
    ]);
  });

  it('returns the full text when nothing matches', () => {
    expect(getHighlightSegments('hello world', [plain('zzz')])).toEqual([
      { text: 'hello world', layer: null },
    ]);
  });

  it('does not loop forever on zero-length matches', () => {
    expect(getHighlightSegments('ab', [/(?:)/g])).toEqual([{ text: 'ab', layer: null }]);
  });

  it('paints each layer where the layers do not overlap', () => {
    expect(getHighlightSegments('GET /auth POST /users', [plain('get'), plain('post')])).toEqual([
      { text: 'GET', layer: 0 },
      { text: ' /auth ', layer: null },
      { text: 'POST', layer: 1 },
      { text: ' /users', layer: null },
    ]);
  });

  it('keeps an earlier layer whole and skips a later match that overlaps it', () => {
    // The filter comes first, so its match is never split by a highlight.
    expect(getHighlightSegments('loggerMiddleware', [plain('logger'), plain('rMid')])).toEqual([
      { text: 'logger', layer: 0 },
      { text: 'Middleware', layer: null },
    ]);
    expect(getHighlightSegments('loggerMiddleware', [plain('rMid'), plain('logger')])).toEqual([
      { text: 'logge', layer: null },
      { text: 'rMid', layer: 0 },
      { text: 'dleware', layer: null },
    ]);
  });
});

describe('getNextSearchColor', () => {
  it('hands out a removed box’s color before later ones', () => {
    const terms = termsFor('a', 'b', 'c');
    expect(terms.map(term => term.color)).toEqual(SEARCH_COLORS.slice(0, 3));
    expect(getNextSearchColor(terms.filter(term => term.search !== 'b'))).toBe(SEARCH_COLORS[1]);
  });

  it('cycles once every color is in use', () => {
    const terms = termsFor(...SEARCH_COLORS.map((_, index) => `term ${index}`));
    expect(getNextSearchColor(terms)).toBe(SEARCH_COLORS[0]);
  });
});

describe('addSearchTerm', () => {
  it('adds an empty box that highlights, with its own id and color', () => {
    const [first, added] = addSearchTerm(termsFor('error'));
    expect(added).toMatchObject({ search: '', isFilter: false, color: SEARCH_COLORS[1] });
    expect(added.id).not.toBe(first.id);
  });
});

describe('compileSearchTerms', () => {
  it('filters with the filter boxes and paints them before the highlights', () => {
    const [highlight, filter] = termsFor('get', 'post').map((term, index) => ({
      ...term,
      isFilter: index === 1,
    }));
    const compiled = compileSearchTerms([highlight, filter]);
    expect(compiled.filters).toHaveLength(1);
    expect('POST /users'.match(compiled.filters[0])?.[0]).toBe('POST');
    expect(compiled.layers.map(layer => layer.color)).toEqual([filter.color, highlight.color]);
    expect(compiled.error).toBe('');
  });

  it('skips empty boxes', () => {
    expect(compileSearchTerms(termsFor('', 'get')).layers).toHaveLength(1);
  });

  it('leaves out a box that does not compile, says why, and keeps the others', () => {
    const [broken, working] = termsFor('get [', 'post');
    const compiled = compileSearchTerms([{ ...broken, isRegex: true }, working]);
    expect(compiled.error).toMatch(/Invalid regular expression/);
    expect(compiled.filters).toHaveLength(0);
    expect(compiled.layers.map(layer => layer.color)).toEqual([working.color]);
  });
});
