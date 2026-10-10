import { describe, expect, it } from 'vitest';

import {
  buildHighlightRegex,
  escapeRegExp,
  getHighlightSegments,
} from '../../../../src/frontend/lib/highlight';

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
    const regex = buildHighlightRegex('foo', { caseSensitive: false, regex: false });
    expect(getHighlightSegments('a foo b foo', regex)).toEqual([
      { text: 'a ', isHighlighted: false },
      { text: 'foo', isHighlighted: true },
      { text: ' b ', isHighlighted: false },
      { text: 'foo', isHighlighted: true },
    ]);
  });

  it('returns the full text when nothing matches', () => {
    const regex = buildHighlightRegex('zzz', { caseSensitive: false, regex: false });
    expect(getHighlightSegments('hello world', regex)).toEqual([
      { text: 'hello world', isHighlighted: false },
    ]);
  });

  it('does not loop forever on zero-length matches', () => {
    const regex = /(?:)/g;
    expect(getHighlightSegments('ab', regex)).toEqual([
      { text: 'a', isHighlighted: false },
      { text: 'b', isHighlighted: false },
    ]);
  });
});
