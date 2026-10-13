import { describe, expect, it } from 'vitest';

import { diffValues } from '../../../../src/frontend/lib/value_diff';

describe('diffValues', () => {
  it('reports equal values as the same, also when every process lacks the value', () => {
    expect(diffValues(['a', 'a', 'a'])).toEqual({ isSame: true });
    expect(diffValues([null, null])).toEqual({ isSame: true });
  });

  it('names the value most processes share, so the others stand out', () => {
    expect(diffValues(['2.14.0', '2.13.4', '2.14.0'])).toEqual({
      isSame: false,
      majority: '2.14.0',
    });
  });

  it('has no odd one out without a majority', () => {
    expect(diffValues(['a', 'b'])).toEqual({ isSame: false });
    expect(diffValues(['a', 'a', 'b', 'b'])).toEqual({ isSame: false });
    expect(diffValues(['a', 'b', 'c'])).toEqual({ isSame: false });
  });

  it('does not treat a missing value as the norm', () => {
    expect(diffValues([null, null, '3000'])).toEqual({ isSame: false });
  });

  it('marks a process that lacks what most others have', () => {
    expect(diffValues(['info', 'info', null])).toEqual({ isSame: false, majority: 'info' });
  });

  it('tells an empty value from a missing one', () => {
    expect(diffValues(['', null])).toEqual({ isSame: false });
  });
});
