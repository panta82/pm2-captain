import { promises as fs } from 'node:fs';

import { IContainer } from '../container';

/** What `pm2-captain fake …` asks the running Captain for. */
export type IFakeInvocation = { kind: 'state' } | { kind: 'commands'; commands: unknown[] };

const ASSIGNMENT_PATTERN = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/s;

// The fields that the leading plain arguments of a command stand for.
function positionalFields(type: string) {
  if (type.startsWith('world.')) {
    return ['scenario'];
  }
  if (type.startsWith('daemon.')) {
    return ['daemon'];
  }
  if (type.startsWith('process.') || type.startsWith('log.')) {
    return ['daemon', 'process'];
  }
  return [];
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

/** Runs `pm2-captain fake …` against the Captain on the configured port. */
export async function runFakeCommandLine(
  { captainLauncher, settings }: Pick<IContainer, 'captainLauncher' | 'settings'>,
  args: string[]
) {
  const fail = (message: string) => {
    console.error(message);
    process.exitCode = 1;
  };

  let invocation: IFakeInvocation;
  try {
    invocation = await parseFakeCommandLine(args);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Invalid fake command.');
  }

  let response: Response;
  try {
    const health = await (await captainLauncher.requestRunningCaptain('/health')).json();
    if (typeof health !== 'object' || health === null || !('fake' in health) || !health.fake) {
      return fail(
        `The PM2 Captain on port ${settings.port} is not in fake mode. Start one with "pm2-captain --fake".`
      );
    }
    response =
      invocation.kind === 'state'
        ? await captainLauncher.requestRunningCaptain('/api/fake/state')
        : await captainLauncher.requestRunningCaptain('/api/fake/commands', invocation.commands);
  } catch {
    return fail(
      `No PM2 Captain answers on port ${settings.port}. Start one with "pm2-captain --fake".`
    );
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
