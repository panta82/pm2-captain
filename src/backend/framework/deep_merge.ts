import { hasOwnProperty, isObject, isPlainObject } from './tools';
import type { AnyRecord, StringKeys } from './types';

/**
 * Classes can implement this static hook to control how they are merged.
 * Return true if merging has been handled. Otherwise, customMerge will also do its own thing.
 */
export type IDeepMergeCustomHook<
  TTarget extends AnyRecord = AnyRecord,
  TSource extends AnyRecord = AnyRecord,
> = (
  target: TTarget,
  source: TSource,
  sourceKey: StringKeys<TSource>,
  options: IDeepMergeOptions
) => boolean;

export interface IDeepMergeOptions {
  /** Key on Ctr we will look at to determine which keys we can touch. Intended to map to Model.keys */
  keyLookupProp?: string;

  /** Key on Ctr we will look at to get our customMergeHook */
  customHookProp?: string;

  /** Customize merging by providing this method. */
  customHook?: IDeepMergeCustomHook | null;

  /** Merge arrays instead of overwriting them. */
  mergeArrays?: boolean;
}

// *********************************************************************************************************************

/**
 * Like lodash.merge(), except with a few custom properties.
 * - Do not add properties outside of "keys" lookup, which can be found on constructor.
 *   The exact property we look at is determined by keyLookupProp. Set to null to disable functionality.
 * - Execute customHook, if Ctr[customHookProp] is a function.
 * - Arrays are not merged, new array overwrites the old one (unless MERGE_ARRAYS_FLAG is set on constructor)
 * - Undefineds are ignored
 * - Instances are copied over, we don't touch them
 * NOTE: We are NOT (always) cloning the source properties!
 *       In particular, arrays and constructed objects will retain references to the source(s).
 *       This is done to avoid complications of trying to "magically" clone constructed objects.
 *       If it ever becomes a problem, then adjust. If you need "pure" cloned objects, look into lodash.clone()
 */
export function deepMerge<TObject extends AnyRecord>(
  target: Partial<TObject>,
  ...sources: Partial<TObject>[]
): TObject {
  return customMergeWithOptions(target, sources, deepMerge.DEFAULT_OPTIONS);
}

deepMerge.DEFAULT_OPTIONS = {
  keyLookupProp: 'keys',
  customHookProp: 'deepMergeCustomHook',
  customHook: null,
} as IDeepMergeOptions;

deepMerge.MERGE_ARRAYS_FLAG = 'MERGE_ARRAYS_FLAG' as const;

deepMerge.withOptions = customMergeWithOptions;

// *********************************************************************************************************************

const NORMALIZED_OPTIONS_SYMBOL = Symbol('NORMALIZED_OPTIONS');

function getKeysLookup(prop: string, target: any) {
  const candidate = target?.constructor?.[prop];
  return candidate && typeof candidate === 'object' ? candidate : null;
}

/**
 * CustomMerge with customizable options. Used internally by customMerge()
 */
export function customMergeWithOptions<TObject extends AnyRecord>(
  target: Partial<TObject>,
  sources: Partial<TObject>[],
  options: IDeepMergeOptions
): TObject {
  if (options !== deepMerge.DEFAULT_OPTIONS && !(options as any)[NORMALIZED_OPTIONS_SYMBOL]) {
    options = { ...deepMerge.DEFAULT_OPTIONS, ...options };
    (options as any)[NORMALIZED_OPTIONS_SYMBOL] = true;
  }

  // Find which key lookup to use. First try for the target
  let keysLookup: { [key: string]: string } | null = null;
  if (options.keyLookupProp) {
    keysLookup = getKeysLookup(options.keyLookupProp, target);
  }

  for (const source of sources) {
    if (Array.isArray(source)) {
      // We were given an array directly. Treat it as the main argument
      customMergeWithOptions(target, source, options);
      continue;
    }

    if (!isObject(source)) {
      // We must have an object from here on
      continue;
    }

    if (!keysLookup && options.keyLookupProp) {
      // We haven't found keysLookup yet, try to snatch it from this source
      // Once keys lookup is found, it stays there. Basically, the left-most object determines the keys.
      keysLookup = getKeysLookup(options.keyLookupProp, source);
    }

    for (const key in source) {
      if (!hasOwnProperty(source, key)) {
        continue;
      }

      const sourceValue = source[key];
      if (sourceValue === undefined) {
        // Do not overwrite with undefineds
        continue;
      }

      if (keysLookup && !keysLookup[key]) {
        // Skip this key, not found in keys lookup
        continue;
      }

      // Try to get things custom-merged
      const customMerged = options.customHook
        ? options.customHook(target, source, key, options)
        : false;
      if (!customMerged) {
        // Do the default thing
        const targetValue = target[key];
        if (isPlainObject(sourceValue)) {
          const canDeepMerge =
            // We can deep merge POJO-s
            isPlainObject(targetValue);
          if (!canDeepMerge) {
            // If we can't deep merge, we need to start with an empty object at the target, overwriting whatever was there previously
            target[key] = {} as any;
          }
          customMergeWithOptions(target[key] as any, [sourceValue], options);
        } else if (Array.isArray(sourceValue)) {
          if (options.mergeArrays && Array.isArray(targetValue)) {
            // Merge arrays
            target[key] = targetValue.concat(sourceValue);
          } else {
            // Otherwise, copy them over
            target[key] = sourceValue;
          }
        } else {
          // In all other cases, copy by reference
          target[key] = sourceValue;
        }
      }
    }
  }

  return target as TObject;
}
