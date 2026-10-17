import { TalentedArgsUsageError } from 'talented-args';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadBackendSettings } from '../../../src/backend/backend_settings';
import { CLI_PROGRAM } from '../../../src/backend/cli_args';
import { FakeCommandSchema } from '../../../src/backend/fake/fake_commands';

const originalPm2Home = process.env.PM2_HOME;

const settingsFor = (...tokens: string[]) => {
  const result = CLI_PROGRAM.parse(tokens);
  if (result.kind !== 'parsed') {
    throw new Error(`Expected parsed arguments, got ${result.kind}`);
  }
  return loadBackendSettings(result.args);
};

const usageErrorFor = (...tokens: string[]) => {
  try {
    CLI_PROGRAM.parse(tokens);
  } catch (error) {
    if (error instanceof TalentedArgsUsageError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the command line to be rejected');
};

afterEach(() => {
  if (originalPm2Home === undefined) {
    delete process.env.PM2_HOME;
  } else {
    process.env.PM2_HOME = originalPm2Home;
  }
  vi.unstubAllEnvs();
});

describe('backend settings', () => {
  it('keeps authentication enabled by default', () => {
    vi.stubEnv('PM2_HOME', '/tmp/pm2-captain-settings-test');
    vi.stubEnv('PM2_CAPTAIN_NO_AUTH', '');

    expect(settingsFor().noAuth).toBe(false);
  });

  it('disables authentication through the CLI', () => {
    vi.stubEnv('PM2_HOME', '/tmp/pm2-captain-settings-test');

    expect(settingsFor('--no-auth').noAuth).toBe(true);
  });

  it('disables authentication through the environment', () => {
    vi.stubEnv('PM2_HOME', '/tmp/pm2-captain-settings-test');
    vi.stubEnv('PM2_CAPTAIN_NO_AUTH', 'true');

    expect(settingsFor().noAuth).toBe(true);
  });

  it.each([
    [[], '', 'auto'],
    [['--open'], '', 'always'],
    [['--no-open'], '', 'never'],
    [[], 'true', 'never'],
    [['--open'], 'true', 'always'],
  ])('resolves browser opening for %j with PM2_CAPTAIN_NO_OPEN=%j', (args, noOpen, expected) => {
    vi.stubEnv('PM2_HOME', '/tmp/pm2-captain-settings-test');
    vi.stubEnv('PM2_CAPTAIN_NO_OPEN', noOpen);

    expect(settingsFor(...args).browserOpen).toBe(expected);
  });

  it('passes every argument after the ssh subcommand to SSH', () => {
    vi.stubEnv('PM2_HOME', '/tmp/pm2-captain-settings-test');

    const settings = settingsFor('--port', '4321', 'ssh', '-p', '2222', 'captain@example.com');

    expect(settings.port).toBe(4321);
    expect(settings.sshArgs).toEqual(['-p', '2222', 'captain@example.com']);
  });

  it('stays out of fake mode unless asked', () => {
    vi.stubEnv('PM2_CAPTAIN_FAKE', '');
    vi.stubEnv('PM2_CAPTAIN_PORT', '');

    expect(settingsFor()).toMatchObject({ fake: null, fakeCommand: null, port: 3212 });
  });

  it.each([
    [['--fake'], '', 'basic', 3213],
    [['--fake', 'busy'], '', 'busy', 3213],
    [['--fake', './scenario.json', '--port', '4000'], '', './scenario.json', 4000],
    // The scenario is optional, so what follows --fake can be something else.
    [['--fake', '--no-open'], '', 'basic', 3213],
    [['--fake', 'ssh', 'deploy@example.com'], '', 'basic', 3213],
    [[], 'edge', 'edge', 3213],
    [['--fake', 'busy'], 'edge', 'busy', 3213],
  ])('enters fake mode for %j with PM2_CAPTAIN_FAKE=%j', (args, environment, scenario, port) => {
    vi.stubEnv('PM2_CAPTAIN_FAKE', environment);
    vi.stubEnv('PM2_CAPTAIN_PORT', '');

    expect(settingsFor(...args)).toMatchObject({ fake: { scenario }, port });
  });

  it('passes every argument after the fake subcommand on, and targets the fake port', () => {
    vi.stubEnv('PM2_CAPTAIN_FAKE', '');
    vi.stubEnv('PM2_CAPTAIN_PORT', '');

    expect(settingsFor('fake', 'process.set', 'local', 'api', '--', '--fake')).toMatchObject({
      fake: null,
      fakeCommand: ['process.set', 'local', 'api', '--', '--fake'],
      port: 3213,
    });
  });

  it('requires something for the fake subcommand to do', () => {
    expect(usageErrorFor('fake')).toMatchObject({ code: 'missing_required', option: '--command' });
  });

  it('requires an SSH destination', () => {
    expect(usageErrorFor('ssh')).toMatchObject({ code: 'missing_required', option: '--ssh-args' });
  });

  it('rejects unknown options', () => {
    expect(usageErrorFor('--nope')).toMatchObject({ code: 'unknown_option' });
  });

  it('shows the help of the ssh and fake subcommands instead of passing --help on', () => {
    expect(CLI_PROGRAM.parse(['ssh', '--help'])).toEqual({ kind: 'help', command: 'ssh' });
    expect(CLI_PROGRAM.parse(['fake', '-h'])).toEqual({ kind: 'help', command: 'fake' });
  });

  it('lists every fake command in the fake help', () => {
    const help = CLI_PROGRAM.help('fake', { width: 200 });

    for (const command of FakeCommandSchema.options) {
      expect(help).toContain(`  ${command.shape.type.value} `);
    }
    expect(help).toContain('update.set status=<value> [field=value …]');
  });
});
