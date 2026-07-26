import { CustomError } from './errors';

/**
 * Like Object.values(), except preserves types
 */
export function typedValues<T extends object>(target: T): Array<T[keyof T]> {
  return Object.values(target) as Array<T[keyof T]>;
}

/**
 * Helper around Object.prototype.hasOwnProperty
 */
export function hasOwnProperty(ob: object, key: string) {
  return Object.prototype.hasOwnProperty.call(ob, key);
}

/**
 * Checks if `value` is an object (but not null).
 */
export function isObject(value: any): value is object {
  return typeof value === 'object' && value !== null;
}

/**
 * Checks if `value` is a plain object, that is, an object created by the `Object`
 * constructor or one with a `[[Prototype]]` of `null`.
 */
export function isPlainObject(value: any): value is object {
  if (value === null || typeof value !== 'object' || value === undefined) {
    return false;
  }
  let proto = Object.getPrototypeOf(value);
  if (proto === null) {
    return true;
  }
  let ctor = Object.prototype.hasOwnProperty.call(proto, 'constructor') && proto.constructor;
  return (
    typeof ctor === 'function' &&
    ctor instanceof ctor &&
    Function.prototype.toString.call(ctor) === Function.prototype.toString.call(Object)
  );
}

/**
 * Convert array to string in a nice way
 * @param arr
 * @param quote String to use to quote elements
 * @param delimiter String to use to delineate elements
 * @param lastDelimiter If provided, this will be used between the last two elements
 */
export function arrToStr(
  arr: any[] | null,
  quote = '"',
  delimiter = ', ',
  lastDelimiter = undefined
) {
  if (!arr || !Array.isArray(arr)) {
    return '';
  }
  quote = quote || '';
  delimiter = delimiter || '';
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) {
      if (i === arr.length - 1 && lastDelimiter !== undefined) {
        result.push(lastDelimiter);
      } else {
        result.push(delimiter);
      }
    }
    const value = quote + arr[i] + quote;
    result.push(value);
  }
  return result.join('');
}

// *********************************************************************************************************************

export type IPromtzel<T> = Promise<T> & {
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
  callback: (err: any, value?: T) => void;
};

/**
 * Create a promise with a few extra props that make it a bit
 * easier to use with callback-based code
 * @example
 * const p = prometzel();
 * fs.readFile('/tmp/file.txt', 'utf8', p.callback);
 * return p;
 */
export function promtzel<T>(): IPromtzel<T> {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  }) as IPromtzel<T>;

  (promise as any).resolve = resolve;
  (promise as any).reject = reject;
  promise.callback = (err, res) => {
    if (err) {
      promise.reject(err);
    } else {
      promise.resolve(res as any);
    }
  };

  return promise;
}

// *********************************************************************************************************************

/**
 * Wait for given function to return a truthy value, then resolve that value
 */
export async function waitFor<T>(
  fn: () => Promise<T> | T | null,
  intervalMs = 500,
  timeoutMs = 60 * 1000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new waitFor.TimeoutError(timeoutMs));
    }, timeoutMs);

    const interval = setInterval(async () => {
      try {
        const result = await fn();
        if (result) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve(result);
        }
      } catch (err) {
        clearInterval(interval);
        clearTimeout(timeout);
        reject(err);
      }
    }, intervalMs);
  });
}
class WaitForTimeoutError extends CustomError {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms`);
  }
}
waitFor.TimeoutError = WaitForTimeoutError;
