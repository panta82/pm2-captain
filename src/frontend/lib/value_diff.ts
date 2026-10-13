export interface IValueDiff {
  isSame: boolean;
  /**
   * The value most processes share. A cell that holds something else is the odd
   * one out. Undefined when the values agree, or when no value has a majority.
   */
  majority?: string;
}

/** Compares one setting across several processes. `null` means a process lacks it. */
export function diffValues(values: Array<string | null>): IValueDiff {
  const counts = new Map<string | null, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  if (counts.size < 2) {
    return { isSame: true };
  }
  const [topValue, topCount] = [...counts].sort((left, right) => right[1] - left[1])[0];
  // A setting that most processes simply lack (PORT on workers) has no odd one out.
  if (topValue === null || topCount <= values.length / 2) {
    return { isSame: false };
  }
  return { isSame: false, majority: topValue };
}
