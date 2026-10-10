/** The daemon form's view of a stored list of SSH arguments. */
export interface ISshFields {
  destination: string;
  port: string;
  options: string;
}

export function splitArguments(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) {
        quote = '';
      } else {
        current += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        result.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (escaped || quote) {
    throw new Error('SSH options contain an unfinished quote or escape.');
  }
  if (current) {
    result.push(current);
  }
  return result;
}

/** Quotes one argument so that splitArguments() reads it back unchanged. */
function quoteArgument(argument: string): string {
  if (/^[^\s'"\\]+$/.test(argument)) {
    return argument;
  }
  if (!argument.includes("'")) {
    return `'${argument}'`;
  }
  return `"${argument.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * Splits stored SSH arguments into form fields. The destination is always the
 * last argument, because Captain appends its own remote command after it.
 */
export function sshArgsToFields(sshArgs: string[]): ISshFields {
  const options = sshArgs.slice(0, -1);
  const portIndex = options.findIndex(
    (argument, index) => argument === '-p' && /^\d+$/.test(options[index + 1] ?? '')
  );
  const port = portIndex < 0 ? '' : options.splice(portIndex, 2)[1];
  return {
    destination: sshArgs.at(-1) ?? '',
    port,
    options: options.map(quoteArgument).join(' '),
  };
}

export function fieldsToSshArgs({ destination, port, options }: ISshFields): string[] {
  return [...splitArguments(options), ...(port ? ['-p', port] : []), destination.trim()];
}
