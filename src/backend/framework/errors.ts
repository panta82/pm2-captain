export class CustomError extends Error {
  public innerError: Error | null = null;
  public name: string;

  constructor(message: string, innerError?: Error) {
    // Fix typescript custom Error prototype chain
    // https://github.com/Microsoft/TypeScript/wiki/Breaking-Changes#extending-built-ins-like-error-array-and-map-may-no-longer-work
    // https://github.com/reduardo7/ts-base-error/blob/master/src/index.ts
    const trueProto = new.target.prototype;

    super(message);

    Object.setPrototypeOf(this, trueProto);

    Object.defineProperties(this, {
      message: { enumerable: true, writable: true },
      stack: { enumerable: true, writable: true },
      name: { enumerable: true, writable: true },
    });

    if (innerError) {
      this.innerError = innerError;
      // Make sure inner error can also be serialized to JSON
      Object.defineProperties(this.innerError, {
        message: { enumerable: true, writable: true },
        stack: { enumerable: true, writable: true },
        name: { enumerable: true, writable: true },
      });
    }

    this.name = this.constructor.name;

    // Extend stack trace
    if (this.innerError && this.innerError.stack) {
      this.stack +=
        '\n    ================================================================================\n' +
        this.innerError.stack
          .split('\n')
          .map(line => '    ' + line)
          .join('\n');
    }
  }

  contextualize(context: string): CustomError {
    return new CustomError(`${context}: ${this.message}`, this);
  }

  static contextualize(error: any, context: string): CustomError {
    if (error instanceof CustomError) {
      return error.contextualize(context);
    } else {
      return new CustomError(`${context}: ${error.message}`, error);
    }
  }
}
