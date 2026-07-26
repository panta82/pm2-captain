import libPath from 'path';

/**
 * Prune prefixes can be a list of line prefixes that will be cut out of stack trace.
 * You would use this to hide some utility code, for example
 */
type IStackTracePruneSpec = string | RegExp;

export interface IStackTraceLine {
  /**
   * Method name or code snippet (eg. "new Test()" or "thing.method()")
   */
  method: string | null;

  /**
   * Path to the file
   */
  path: string;

  /**
   * Line number where the error happened
   */
  line: number | null;

  /**
   * Column where the error happened
   */
  column: number | null;
}

interface IStackTraceOptions {
  /** How many lines to cut from the top. This defaults to 1, which ensures StackTrace code is not visible. */
  cutLines: number;

  /** Prune all lines, instead of just lines at the top */
  pruneAll: boolean;
}

/**
 * Representation of stack trace at particular point in code. Can be used to extend stack trace on errors.
 * @example
 *  const stackTrace = StackTrace.capture();
 *  // ...
 *  stackTrace.extend(err);
 *
 * TODO: Look into taking the full stack trace: https://stackoverflow.com/a/14172822/2405595
 */
export class StackTrace {
  static DEFAULT_OPTIONS: IStackTraceOptions = {
    cutLines: 1,
    pruneAll: false,
  };

  private readonly pruneSpecs: IStackTracePruneSpec[] | null;
  private options: IStackTraceOptions;

  constructor(
    public stack: string,
    pruneSpecs: IStackTracePruneSpec[] | null = null,
    options = StackTrace.DEFAULT_OPTIONS
  ) {
    this.pruneSpecs = pruneSpecs;
    this.options = options;
  }

  getLines() {
    let lines = this.stack.split('\n');
    let sliceIndex = (this.options.cutLines || 0) + 1;

    if (this.pruneSpecs && !this.options.pruneAll) {
      while (sliceIndex < lines.length) {
        if (this.shouldPruneLine(lines[sliceIndex])) {
          // We need to prune this line
          sliceIndex++;
        } else {
          break;
        }
      }
    }

    lines = lines.slice(sliceIndex);

    if (this.pruneSpecs && this.options.pruneAll) {
      lines = lines.filter(line => !this.shouldPruneLine(line));
    }

    return lines;
  }

  private shouldPruneLine(line: string) {
    if (this.pruneSpecs) {
      for (const prefix of this.pruneSpecs) {
        const matches =
          prefix instanceof RegExp ? prefix.test(line) : line.startsWith(`    at ${prefix}`);
        if (matches) {
          return true;
        }
      }
    }
    return false;
  }

  getLineDetails(): IStackTraceLine[] {
    const lines = this.getLines();

    return lines.map(line => {
      // Full stack trace
      let match = /^ {4}at (.*) \((.*):([0-9]+):([0-9]+)\)$/.exec(line);
      if (match) {
        return {
          method: match[1],
          path: match[2],
          line: Number(match[3]),
          column: Number(match[4]),
        };
      }

      // "    at /path/to/file.ts:12:19"
      match = /^ {4}at ([^:]+):([0-9]+):([0-9]+)$/.exec(line);
      if (match) {
        return {
          method: null,
          path: match[1],
          line: Number(match[2]),
          column: Number(match[3]),
        };
      }
      // "    at Array.forEach (<anonymous>)"
      match = /^ {4}at (.*) \([^)]\)$/.exec(line);
      if (match) {
        return {
          method: match[1],
          path: match[2],
          line: null,
          column: null,
        };
      }

      // Fallback
      return {
        method: null,
        path: 'unknown',
        line: null,
        column: null,
      };
    });
  }

  /**
   * Apply this stack trace to an error, so its stack will contain both traces
   * @param err
   */
  extend(err: Error) {
    const stack = this.getLines().join('\n');

    err.stack =
      err.stack +
      '\n    --------------------------------------------------------------------------------\n' +
      stack;

    return err;
  }

  /**
   * Capture stack trace here. Prune prefixes can be a list of line prefixes that will be cut out of stack trace
   * (if you want to hide some utility code).
   * @return StackTrace
   */
  static capture(
    pruneSpecs: IStackTracePruneSpec[] | null = null,
    options?: IStackTraceOptions
  ): StackTrace {
    const tempErr = new Error();
    Error.captureStackTrace(tempErr, 'StackTrace dummy error' as any);
    return new StackTrace(tempErr.stack as string, pruneSpecs, options);
  }
}

// *********************************************************************************************************************

/**
 * A class that encapsulates the information about a direct callee of some function. This is useful for helping debug
 * code ("this was defined in such and such file"), and for deduping multiple places that want to use the same global
 * resources (both A and B want to use global cache key "Foo" without coordinating).
 */
export class CalleeInfo {
  path: string = '';
  relativePath: string = '';
  lineNumber: number | null = null;

  get description() {
    return `${this.relativePath}:${this.lineNumber}`;
  }

  static generate(pruneSpecs: IStackTracePruneSpec[]): CalleeInfo {
    const stackLine = StackTrace.capture(pruneSpecs, {
      // Need to cut 2 instead of 1, to encompass this method as well
      cutLines: 2,
      pruneAll: false,
    }).getLineDetails()[0];

    const handlerInfo = new CalleeInfo();
    handlerInfo.path = stackLine.path;
    handlerInfo.relativePath = libPath.relative(__dirname, stackLine.path);
    // Take care of relative paths, like ../../a/b/c. Basically, make sure path is "rooted" at the project base.
    while (handlerInfo.relativePath.indexOf('../') === 0) {
      handlerInfo.relativePath = handlerInfo.relativePath.slice(3);
    }
    handlerInfo.lineNumber = stackLine.line;
    return handlerInfo;
  }
}
