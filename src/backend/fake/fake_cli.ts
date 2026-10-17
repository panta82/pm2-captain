import { promises as fs } from 'node:fs';
import { z } from 'zod';

import { IContainer } from '../container';
import { FakeCommandSchema } from './fake_commands';

/** What `pm2-captain fake …` asks the running Captain for. */
export type IFakeInvocation = { kind: 'state' } | { kind: 'commands'; commands: unknown[] };

const ASSIGNMENT_PATTERN = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/s;

// The fields that the leading plain arguments of a command stand for.
function positionalFields(type: string) {
  if (type.startsWith('world.')) {
    return ['scenario'];
  }
  if (type.startsWith('daemon.') || /^registry\.(edit|remove|add)$/.test(type)) {
    return ['daemon'];
  }
  if (type.startsWith('process.') || type.startsWith('log.')) {
    return ['daemon', 'process'];
  }
  return [];
}

/** How a field value is written on the command line, such as `online|stopped` or `number`. */
function describeValue(schema: z.ZodType): string {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return describeValue(schema.unwrap() as z.ZodType);
  }
  if (schema instanceof z.ZodNullable) {
    return `${describeValue(schema.unwrap() as z.ZodType)}|null`;
  }
  if (schema instanceof z.ZodUnion) {
    return [...new Set(schema.options.map(option => describeValue(option as z.ZodType)))].join('|');
  }
  if (schema instanceof z.ZodEnum) {
    return schema.options.join('|');
  }
  if (schema instanceof z.ZodLiteral) {
    return String(schema.value);
  }
  if (schema instanceof z.ZodNumber) {
    return 'number';
  }
  if (schema instanceof z.ZodBoolean) {
    return 'true|false';
  }
  return schema instanceof z.ZodString ? 'text' : 'json';
}

/**
 * Help rows for `pm2-captain fake --help`: every fake command in its short form,
 * with its fields. Built from FakeCommandSchema, so it cannot fall behind it.
 */
export function describeFakeCommands(): { name: string; description: string }[] {
  const rows = [{ name: 'state', description: 'Prints the fake world as JSON.' }];
  for (const command of FakeCommandSchema.options) {
    const { type, lines, ...fields } = command.shape as Record<string, z.ZodType>;
    const commandType = String((type as z.ZodLiteral).value);
    const positionals = positionalFields(commandType);
    const isOptional = (key: string) => fields[key]?.safeParse(undefined).success === true;
    const usage = [commandType];
    for (const field of positionals) {
      usage.push(isOptional(field) ? `[${field}]` : `<${field}>`);
    }
    const keyed = Object.entries(fields).filter(([key]) => !positionals.includes(key));
    for (const [key] of keyed.filter(([key]) => !isOptional(key))) {
      usage.push(`${key}=<value>`);
    }
    if (keyed.some(([key]) => isOptional(key))) {
      usage.push('[field=value …]');
    }
    if (lines) {
      usage.push('-- <line …>');
    }
    const fieldList = keyed.map(([key, schema]) => `${key}=${describeValue(schema)}`);
    rows.push({
      name: usage.join(' '),
      description: [
        command.description ?? '',
        fieldList.length ? `Fields: ${fieldList.join(', ')}.` : '',
        lines ? 'Lines come after --, or from file=<path>.' : '',
      ]
        .filter(Boolean)
        .join(' '),
    });
  }
  return rows;
}

async function readLines(path: string) {
  const lines = (await fs.readFile(path, 'utf8')).split(/\r?\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

/**
 * Reads `state`, a JSON command (or array of them), or the short form:
 *
 *   <type> [daemon [process]] [key=value …] [-- line …]
 *
 * A value is read as JSON when it is JSON, otherwise as text. `file=<path>`
 * sends the lines of a file, and a `.json` scenario is read here and sent whole.
 */
export async function parseFakeCommandLine(args: string[]): Promise<IFakeInvocation> {
  const [first, ...rest] = args;
  if (first === 'state' && !rest.length) {
    return { kind: 'state' };
  }
  if (first.startsWith('{') || first.startsWith('[')) {
    if (rest.length) {
      throw new Error('A JSON fake command takes no further arguments.');
    }
    const parsed: unknown = JSON.parse(first);
    return { kind: 'commands', commands: Array.isArray(parsed) ? parsed : [parsed] };
  }

  const command: Record<string, unknown> = { type: first };
  const positionals = positionalFields(first);
  let positionalIndex = 0;
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (argument === '--') {
      command.lines = rest.slice(index + 1);
      break;
    }
    const assignment = ASSIGNMENT_PATTERN.exec(argument);
    if (assignment) {
      const [, key, value] = assignment;
      if (key === 'file') {
        command.lines = await readLines(value);
        continue;
      }
      try {
        command[key] = JSON.parse(value);
      } catch {
        command[key] = value;
      }
      continue;
    }
    const field = positionals[positionalIndex++];
    if (!field) {
      throw new Error(`Unexpected argument "${argument}" for the fake command "${first}".`);
    }
    if (field === 'process') {
      // A number is a PM2 ID, anything else a process name.
      command[field] = /^\d+$/.test(argument) ? Number(argument) : argument;
    } else if (field === 'scenario' && argument.endsWith('.json')) {
      command[field] = JSON.parse(await fs.readFile(argument, 'utf8'));
    } else {
      command[field] = argument;
    }
  }
  return { kind: 'commands', commands: [command] };
}

/**
 * Reads the file a desktop backend in fake mode writes into its profile: its
 * loopback address and a token that only the fake routes accept.
 */
async function readControlFile(path: string) {
  const content: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
  const control = content as { baseURL?: unknown; token?: unknown } | null;
  if (
    typeof control?.baseURL !== 'string' ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(control.baseURL) ||
    typeof control.token !== 'string' ||
    !control.token
  ) {
    throw new Error(`${path} is not a PM2 Captain fake control file.`);
  }
  return { baseURL: control.baseURL, token: control.token };
}

/**
 * Runs `pm2-captain fake …` against the Captain on the configured port, or with
 * `--control <file>` against the desktop app that wrote that file.
 */
export async function runFakeCommandLine(
  { captainLauncher, settings }: Pick<IContainer, 'captainLauncher' | 'settings'>,
  args: string[]
) {
  const fail = (message: string) => {
    console.error(message);
    process.exitCode = 1;
  };

  let request = captainLauncher.requestRunningCaptain;
  let target = `port ${settings.port}`;
  let commandArgs = args;
  if (args[0] === '--control') {
    if (!args[1] || args.length < 3) {
      return fail('Use: pm2-captain fake --control <file> <command>');
    }
    let control: { baseURL: string; token: string };
    try {
      control = await readControlFile(args[1]);
    } catch (error) {
      return fail(
        `Unable to read the fake control file ${args[1]}. Is the desktop app running in fake mode? ${
          error instanceof Error ? error.message : ''
        }`.trim()
      );
    }
    request = (path: string, body?: unknown) =>
      fetch(`${control.baseURL}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          authorization: `Bearer ${control.token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    target = control.baseURL;
    commandArgs = args.slice(2);
  }

  let invocation: IFakeInvocation;
  try {
    invocation = await parseFakeCommandLine(commandArgs);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Invalid fake command.');
  }

  let response: Response;
  try {
    const health = await (await request('/health')).json();
    if (typeof health !== 'object' || health === null || !('fake' in health) || !health.fake) {
      return fail(
        `The PM2 Captain at ${target} is not in fake mode. Start one with "pm2-captain --fake".`
      );
    }
    response =
      invocation.kind === 'state'
        ? await request('/api/fake/state')
        : await request('/api/fake/commands', invocation.commands);
  } catch {
    return fail(`No PM2 Captain answers at ${target}. Start one with "pm2-captain --fake".`);
  }

  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) {
    return fail(
      response.status === 401
        ? 'The running PM2 Captain uses another launch token.'
        : typeof body?.error === 'string'
          ? body.error
          : `The fake command failed (${response.status}).`
    );
  }
  console.log(invocation.kind === 'state' ? JSON.stringify(body, null, 2) : 'OK');
}
