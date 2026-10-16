import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import libOs from 'node:os';
import libPath from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { parseFakeCommandLine, runFakeCommandLine } from '../../../../src/backend/fake/fake_cli';
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

describe('fake registry and update commands', () => {
  it('reads them in the short form', async () => {
    expect(
      await commandsOf('registry.edit', 'blue', 'label=Blue', 'pm2Home=/srv/blue2/.pm2')
    ).toEqual([
      { type: 'registry.edit', daemon: 'blue', label: 'Blue', pm2Home: '/srv/blue2/.pm2' },
    ]);
    expect(await commandsOf('registry.fail', 'reason=missing')).toEqual([
      { type: 'registry.fail', reason: 'missing' },
    ]);
    const [update] = await commandsOf(
      'update.set',
      'status=downloaded',
      'version=9.9.9',
      'installKind=deb'
    );
    expect(FakeCommandSchema.parse(update)).toEqual({
      type: 'update.set',
      status: 'downloaded',
      version: '9.9.9',
      installKind: 'deb',
    });
    expect(() =>
      FakeCommandSchema.parse({ type: 'update.install-outcome', outcome: 'installed' })
    ).toThrow();
  });
});

describe('desktop fake control', () => {
  it('sends commands to the address and token in a control file', async () => {
    const received: Array<{ url?: string; authorization?: string; body: string }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => (body += chunk));
      request.on('end', () => {
        received.push({ url: request.url, authorization: request.headers.authorization, body });
        response.setHeader('content-type', 'application/json');
        response.end(request.url === '/health' ? '{"fake":true}' : '{"applied":1}');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const controlFile = libPath.join(directory, 'fake-control.json');
    await fs.writeFile(
      controlFile,
      JSON.stringify({ baseURL: `http://127.0.0.1:${port}`, token: 'control-token' })
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runFakeCommandLine({ captainLauncher: {}, settings: { port: 3213 } } as never, [
        '--control',
        controlFile,
        'update.reset',
      ]);
    } finally {
      log.mockRestore();
      await new Promise(resolve => server.close(resolve));
    }

    expect(received.map(request => [request.url, request.authorization])).toEqual([
      ['/health', 'Bearer control-token'],
      ['/api/fake/commands', 'Bearer control-token'],
    ]);
    expect(JSON.parse(received[1].body)).toEqual([{ type: 'update.reset' }]);
  });

  it('refuses a control file that points anywhere but a loopback port', async () => {
    const controlFile = libPath.join(directory, 'bad-control.json');
    await fs.writeFile(
      controlFile,
      JSON.stringify({ baseURL: 'http://example.com:80', token: 'control-token' })
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await runFakeCommandLine({ captainLauncher: {}, settings: { port: 3213 } } as never, [
        '--control',
        controlFile,
        'state',
      ]);
      expect(error.mock.calls[0][0]).toContain('not a PM2 Captain fake control file');
      expect(process.exitCode).toBe(1);
    } finally {
      error.mockRestore();
      process.exitCode = undefined;
    }
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
