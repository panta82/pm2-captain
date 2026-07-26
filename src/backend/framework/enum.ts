import { ZodEnum } from 'zod';

type IUnionToTuple<U extends string | number, R extends any[] = []> = {
  [S in U]: Exclude<U, S> extends never ? [...R, S] : IUnionToTuple<Exclude<U, S>, [...R, S]>;
}[U];

/**
 * A class that encapsulates a hash key lookup, list of values and labels
 */
export class Enum<T extends string | number> {
  public readonly lookup: { [key in T]: key };
  public readonly tuple: IUnionToTuple<T>;
  public labels: { [key in T]: string };
  //public schema: ZodEnum<T[]>;

  constructor(keysToLabels: { [key in T]: string });
  constructor(...enumValues: readonly T[]);
  constructor(...enumValuesOrJustLabels: any[]) {
    let enumValues;
    if (enumValuesOrJustLabels.length === 1 && typeof enumValuesOrJustLabels[0] === 'object') {
      // We are given an object with labels. Enum values will be keys.
      this.labels = enumValuesOrJustLabels[0];
      enumValues = Object.keys(this.labels);
    } else {
      // We are given a bunch of strings, so let's use them as enum values
      enumValues = enumValuesOrJustLabels;
    }

    this.lookup = {} as any;
    for (const item of enumValues) {
      (this.lookup as any)[String(item)] = String(item);
    }
    this.tuple = Object.keys(this.lookup) as any;
    // @ts-ignore
    if (!this.labels) {
      this.labels = this.lookup as any;
    }
  }

  defineLabels = (labels: { [key in T]: string }): this => {
    this.labels = labels;
    return this;
  };

  label = (value: T): string => {
    return this.labels[value];
  };

  has = (value: any): value is T => {
    return !!(this.lookup as any)[value];
  };
}
