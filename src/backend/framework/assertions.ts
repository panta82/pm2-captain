import { CustomError } from './errors';
import { arrToStr, hasOwnProperty } from './tools';
import { IAnyRecord } from './types';

export class AssertionError extends CustomError {
  constructor(message?: string) {
    message ? super(`Assertion error: ${message}`) : super(`Assertion error`);
  }
}

export function assert(condition: any, message?: string | (() => string)): asserts condition {
  if (condition || assert.disabled) {
    return;
  }

  if (typeof message === 'function') {
    message = message();
  }
  throw new AssertionError(message);
}

assert.provided = (vals: IAnyRecord) => {
  const missing = [];
  for (const key in vals) {
    if (hasOwnProperty(vals, key)) {
      if (vals[key] === undefined) {
        missing.push(key);
      }
    }
  }
  if (missing.length > 1) {
    throw new AssertionError(`The following arguments must be provided: ${arrToStr(missing)}`);
  }
  if (missing.length === 1) {
    throw new AssertionError(`Argument "${missing[0]}" must be provided`);
  }
};

assert.exhaustiveCheck = (value: never) => {
  assert(false, `Exhaustive check asserted for value ${value}`);
};

assert.notReached = () => {
  assert(false, `Code path should not be reached`);
};

/**
 * A hook to disable assertion errors under some circumstances
 */
assert.disabled = false;
