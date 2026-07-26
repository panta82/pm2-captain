export type AnyRecord = Record<string, any>;
export type AnyFunction = (...args: any[]) => any;
export type AnyConstructor = new (...args: any[]) => any;
export type Constructor<T> = new (...args: any[]) => T;
export type StringKeys<T> = keyof T extends string ? keyof T : never;

// *********************************************************************************************************************

type RecursionLevel = 0 | 1 | 2 | 3 | 4 | 'max';
type NextRecursionLevel<Level> = Level extends 0
  ? 1
  : Level extends 1
    ? 2
    : Level extends 2
      ? 3
      : Level extends 3
        ? 4
        : 'max';

export type DeepStringPath<
  TTarget extends AnyRecord,
  TLevel extends RecursionLevel = 0,
> = TLevel extends 'max'
  ? never
  : {
      [Key in StringKeys<TTarget>]: TTarget[Key] extends AnyFunction
        ? never
        : TTarget[Key] extends string
          ? `${Key}`
          : `${Key}` | `${Key}.${DeepStringPath<TTarget[Key], NextRecursionLevel<TLevel>>}`;
    }[StringKeys<TTarget>];

export type ValueAtDeepStringPath<
  TTarget extends AnyRecord,
  TPath extends string,
> = TPath extends `${infer Head}.${infer Rest}`
  ? TTarget[Head] extends AnyRecord
    ? ValueAtDeepStringPath<TTarget[Head], Rest>
    : never
  : TPath extends keyof TTarget
    ? TTarget[TPath]
    : never;

export type IDeepArrayPath<
  TTarget extends AnyRecord,
  TLevel extends RecursionLevel = 0,
> = TLevel extends 'max'
  ? never
  : {
      [Key in StringKeys<TTarget>]: TTarget[Key] extends AnyFunction
        ? never
        : TTarget[Key] extends string
          ? [Key]
          : [Key] | [Key, ...IDeepArrayPath<TTarget[Key], NextRecursionLevel<TLevel>>];
    }[StringKeys<TTarget>];

// *********************************************************************************************************************

export type ReverseRecord<T extends Record<keyof T, keyof any>> = {
  [P in T[keyof T]]: {
    [K in keyof T]: T[K] extends P ? K : never;
  }[keyof T];
};

// *********************************************************************************************************************

/**
 * Partialize object deeply.
 * https://stackoverflow.com/a/68699273/2405595
 */
export type DeepPartial<T> = T extends
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | symbol
  | Date
  ? T | undefined
  : // Arrays, Sets and Maps and their readonly counterparts have their items made
    // deeply partial, but their own instances are left untouched
    T extends Array<infer ArrayType>
    ? Array<DeepPartial<ArrayType>>
    : T extends ReadonlyArray<infer ArrayType>
      ? ReadonlyArray<ArrayType>
      : T extends Set<infer SetType>
        ? Set<DeepPartial<SetType>>
        : T extends ReadonlySet<infer SetType>
          ? ReadonlySet<SetType>
          : T extends Map<infer KeyType, infer ValueType>
            ? Map<DeepPartial<KeyType>, DeepPartial<ValueType>>
            : T extends ReadonlyMap<infer KeyType, infer ValueType>
              ? ReadonlyMap<DeepPartial<KeyType>, DeepPartial<ValueType>>
              : // ...and finally, all other objects.
                {
                  [K in keyof T]?: DeepPartial<T[K]>;
                };

// *********************************************************************************************************************

// https://github.com/microsoft/TypeScript/issues/13298#issuecomment-724542300
export type UnionToTuple<T> = (
  (T extends any ? (t: T) => T : never) extends infer U
    ? (U extends any ? (u: U) => any : never) extends (v: infer V) => any
      ? V
      : never
    : never
) extends (_: any) => infer W
  ? [...UnionToTuple<Exclude<T, W>>, W]
  : [];

// *********************************************************************************************************************

// https://stackoverflow.com/a/55483981/2405595

type AssignablePropertyNames<TObject> = {
  [Key in keyof TObject]: TObject[Key] extends AnyFunction
    ? never
    : Key extends `_${string}`
      ? never
      : Key;
}[keyof TObject];
type AssignableProperties<T> = Pick<T, AssignablePropertyNames<T>>;

// *********************************************************************************************************************

export type IClassSubset<
  TModel extends AnyRecord,
  TKeys extends AssignablePropertyNames<TModel>,
> = {
  [key in TKeys]: TModel[key];
};

export type StrictSubset<TSuperset, TTarget> = Partial<TSuperset> &
  Record<Exclude<keyof TTarget, keyof TSuperset>, never>;

// *********************************************************************************************************************

export type ReplaceProperty<T, K extends keyof T, V> = Omit<T, K> & { [P in K]: V };
