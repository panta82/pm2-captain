import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseFakeCommandLine } from '../../../../src/backend/fake/fake_cli';
import { FakeCommandSchema } from '../../../../src/backend/fake/fake_commands';

let directory: string;

beforeAll(async () => {
  directory = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2-captain-fake-cli-'));
});

afterAll(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

const commandsOf = async (...args: string[]) => {
  const invocation = await parseFakeCommandLine(args);
  if (invocation.kind !== 'commands') {
    throw new Error('Expected commands');
  }
  return invocation.commands;
};

describe('fake command line', () => {
  it('asks for the state', async () => {
    expect(await parseFakeCommandLine(['state'])).toEqual({ kind: 'state' });
  });

  it('reads the daemon, the process and typed values from the short form', async () => {
    const commands = await commandsOf(
      'process.set',
      'blue',
      'api',
      'status=errored',
      'cpu=93.5',
      'watching=true',
      'version=null',
      'args=["--port","80"]',
      'nextActionError=EADDRINUSE: port 80'
    );

    expect(commands).toEqual([
      {
        type: 'process.set',
        daemon: 'blue',
        process: 'api',
        status: 'errored',
        cpu: 93.5,
        watching: true,
        version: null,
        args: ['--port', '80'],
        nextActionError: 'EADDRINUSE: port 80',
      },
    ]);
    expect(FakeCommandSchema.safeParse(commands[0]).success).toBe(true);
  });

  it('takes a number for the process as its PM2 ID', async () => {
    expect(await commandsOf('process.remove', 'blue', '3')).toEqual([
      { type: 'process.remove', daemon: 'blue', process: 3 },
    ]);
  });

  it('sends everything after -- as log lines, untouched', async () => {
    expect(
      await commandsOf('log.emit', 'blue', 'api', 'channel=err', '--', 'a=b', '{"not":"parsed"}')
    ).toEqual([
      {
        type: 'log.emit',
        daemon: 'blue',
        process: 'api',
        channel: 'err',
        lines: ['a=b', '{"not":"parsed"}'],
      },
    ]);
  });

  it('sends the lines of a file', async () => {
    const path = libPath.join(directory, 'sample.log');
    await fs.writeFile(path, 'first\n\nthird\n');

    expect(await commandsOf('log.history', 'blue', 'api', `file=${path}`)).toEqual([
      { type: 'log.history', daemon: 'blue', process: 'api', lines: ['first', '', 'third'] },
    ]);
  });

  it('sends a scenario file whole, and a scenario name as it is', async () => {
    const path = libPath.join(directory, 'scenario.json');
    await fs.writeFile(path, JSON.stringify({ daemons: [{ key: 'solo' }] }));

    expect(await commandsOf('world.reset', path)).toEqual([
      { type: 'world.reset', scenario: { daemons: [{ key: 'solo' }] } },
    ]);
    expect(await commandsOf('world.reset', 'busy')).toEqual([
      { type: 'world.reset', scenario: 'busy' },
    ]);
    expect(await commandsOf('world.reset')).toEqual([{ type: 'world.reset' }]);
  });

  it('passes JSON through, one command or several', async () => {
    const command = { type: 'daemon.set', daemon: 'blue', isUp: false };

    expect(await commandsOf(JSON.stringify(command))).toEqual([command]);
    expect(await commandsOf(JSON.stringify([command, command]))).toEqual([command, command]);
  });

  it('rejects an argument it has no place for', async () => {
    await expect(parseFakeCommandLine(['daemon.set', 'blue', 'api'])).rejects.toThrow(
      'Unexpected argument "api"'
    );
  });
});

describe('fake commands', () => {
  it('rejects a misspelled field instead of ignoring it', () => {
    const result = FakeCommandSchema.safeParse({
      type: 'process.set',
      daemon: 'blue',
      process: 'api',
      staus: 'errored',
    });

    expect(result.success).toBe(false);
  });

  it('fills in the channel and the repeat count of emitted lines', () => {
    expect(
      FakeCommandSchema.parse({ type: 'log.emit', daemon: 'blue', process: 0, lines: ['x'] })
    ).toMatchObject({ channel: 'out', repeat: 1 });
  });
});
