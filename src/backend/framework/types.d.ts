export type IAnyRecord = Record<string, any>;
export type IAnyFunction = (...args: any[]) => any;
export type IAnyConstructor = new (...args: any[]) => any;
export type IConstructor<T> = new (...args: any[]) => T;
export type IStringKeys<T> = keyof T extends string ? keyof T : never;

// *********************************************************************************************************************

type IRecursionLevel = 0 | 1 | 2 | 3 | 4 | 'max';
type INextRecursionLevel<Level> = Level extends 0
  ? 1
  : Level extends 1
    ? 2
    : Level extends 2
      ? 3
      : Level extends 3
        ? 4
        : 'max';

export type IDeepStringPath<
  TTarget extends IAnyRecord,
  TLevel extends IRecursionLevel = 0,
> = TLevel extends 'max'
  ? never
  : {
      [Key in IStringKeys<TTarget>]: TTarget[Key] extends IAnyFunction
        ? never
        : TTarget[Key] extends string
          ? `${Key}`
          : `${Key}` | `${Key}.${IDeepStringPath<TTarget[Key], INextRecursionLevel<TLevel>>}`;
    }[IStringKeys<TTarget>];

export type IValueAtDeepStringPath<
  TTarget extends IAnyRecord,
  TPath extends string,
> = TPath extends `${infer Head}.${infer Rest}`
  ? TTarget[Head] extends IAnyRecord
    ? IValueAtDeepStringPath<TTarget[Head], Rest>
    : never
  : TPath extends keyof TTarget
    ? TTarget[TPath]
    : never;

export type IDeepArrayPath<
  TTarget extends IAnyRecord,
  TLevel extends IRecursionLevel = 0,
> = TLevel extends 'max'
  ? never
  : {
      [Key in IStringKeys<TTarget>]: TTarget[Key] extends IAnyFunction
        ? never
        : TTarget[Key] extends string
          ? [Key]
          : [Key] | [Key, ...IDeepArrayPath<TTarget[Key], INextRecursionLevel<TLevel>>];
    }[IStringKeys<TTarget>];

// *********************************************************************************************************************

export type IReverseRecord<T extends Record<keyof T, keyof any>> = {
  [P in T[keyof T]]: {
    [K in keyof T]: T[K] extends P ? K : never;
  }[keyof T];
};

// *********************************************************************************************************************

/**
 * Partialize object deeply.
 * https://stackoverflow.com/a/68699273/2405595
 */
export type IDeepPartial<T> = T extends
  string | number | bigint | boolean | null | undefined | symbol | Date
  ? T | undefined
  : // Arrays, Sets and Maps and their readonly counterparts have their items made
    // deeply partial, but their own instances are left untouched
    T extends Array<infer ArrayType>
    ? Array<IDeepPartial<ArrayType>>
    : T extends ReadonlyArray<infer ArrayType>
      ? ReadonlyArray<ArrayType>
      : T extends Set<infer SetType>
        ? Set<IDeepPartial<SetType>>
        : T extends ReadonlySet<infer SetType>
          ? ReadonlySet<SetType>
          : T extends Map<infer KeyType, infer ValueType>
            ? Map<IDeepPartial<KeyType>, IDeepPartial<ValueType>>
            : T extends ReadonlyMap<infer KeyType, infer ValueType>
              ? ReadonlyMap<IDeepPartial<KeyType>, IDeepPartial<ValueType>>
              : // ...and finally, all other objects.
                {
                  [K in keyof T]?: IDeepPartial<T[K]>;
                };

// *********************************************************************************************************************

// https://github.com/microsoft/TypeScript/issues/13298#issuecomment-724542300
export type IUnionToTuple<T> = (
  (T extends any ? (t: T) => T : never) extends infer U
    ? (U extends any ? (u: U) => any : never) extends (v: infer V) => any
      ? V
      : never
    : never
) extends (_: any) => infer W
  ? [...IUnionToTuple<Exclude<T, W>>, W]
  : [];

// *********************************************************************************************************************

// https://stackoverflow.com/a/55483981/2405595

type IAssignablePropertyNames<TObject> = {
  [Key in keyof TObject]: TObject[Key] extends IAnyFunction
    ? never
    : Key extends `_${string}`
      ? never
      : Key;
}[keyof TObject];
type IAssignableProperties<T> = Pick<T, IAssignablePropertyNames<T>>;

// *********************************************************************************************************************

export type IClassSubset<
  TModel extends IAnyRecord,
  TKeys extends IAssignablePropertyNames<TModel>,
> = {
  [key in TKeys]: TModel[key];
};

export type IStrictSubset<TSuperset, TTarget> = Partial<TSuperset> &
  Record<Exclude<keyof TTarget, keyof TSuperset>, never>;

// *********************************************************************************************************************

export type IReplaceProperty<T, K extends keyof T, V> = Omit<T, K> & { [P in K]: V };
