import { execFileSync } from 'node:child_process';
import { TalentedArgsUsageError } from 'talented-args';
import { describe, expect, it } from 'vitest';

// @ts-expect-error A plain ES module script without types.
import { createDevLaunch, createDevProgram } from '../../../support/dev_options.mjs';

const launch = (target: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const result = createDevProgram(target).parse(args);
  expect(result.kind).toBe('parsed');
  return createDevLaunch(target, result.args, env);
};

describe.each(['web', 'desktop'])('%s dev launcher', target => {
  it('defaults to real data even with an inherited desktop fake scenario', () => {
    const result = launch(target, [], { PM2_CAPTAIN_DESKTOP_FAKE: 'multi', PATH: '/bin' });
    expect(result.env.PM2_CAPTAIN_DESKTOP_FAKE).toBeUndefined();
    expect(result.env.PATH).toBe('/bin');
    expect(result.args).toEqual([]);
    expect(result.debugArgs).toEqual([]);
  });

  it.each([
    [[], 'basic'],
    [['multi'], 'multi'],
    [['./scenario with spaces.json'], './scenario with spaces.json'],
  ])('translates fake data %j to the child configuration', (args, scenario) => {
    const result = launch(target, ['--fake-data', ...args], { PM2_CAPTAIN_DESKTOP_FAKE: 'busy' });
    if (target === 'desktop') {
      expect(result.env.PM2_CAPTAIN_DESKTOP_FAKE).toBe(scenario);
      expect(result.args).toEqual([]);
    } else {
      expect(result.args).toEqual(['--fake', scenario]);
      expect(result.env.PM2_CAPTAIN_DESKTOP_FAKE).toBeUndefined();
    }
  });

  it('keeps debugger flags separate from application arguments', () => {
    const result = launch(target, ['--fake-data', '--inspect-brk', '--', '--some-option=value']);
    expect(result.debugArgs).toEqual([`--inspect-brk=${target === 'desktop' ? 9338 : 9229}`]);
    expect(result.args).toEqual([
      ...(target === 'web' ? ['--fake', 'basic'] : []),
      '--some-option=value',
    ]);
    expect(launch(target, ['--inspect=9348']).debugArgs).toEqual(['--inspect=9348']);
    expect(launch(target, ['--inspect-brk=0']).debugArgs).toEqual(['--inspect-brk=0']);
  });

  it('rejects conflicting debugger modes and invalid ports before launching', () => {
    expect(() => launch(target, ['--inspect', '--inspect-brk'])).toThrow('Choose either');
    for (const port of ['-1', '65536', '1.5', 'wrong']) {
      expect(() => launch(target, [`--inspect-brk=${port}`])).toThrow(TalentedArgsUsageError);
    }
    expect(() => launch(target, ['--fake-dtaa'])).toThrow(TalentedArgsUsageError);
  });

  it('prints launcher help and exits without starting the app or watchers', () => {
    const output = execFileSync(process.execPath, [`support/${target}/dev.mjs`, '--help'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(output).toContain(`npm run ${target}:dev --`);
    expect(output).toContain('--fake-data');
    expect(output).toContain('--inspect-brk');
    expect(output).toContain('--interactive');
  });
});

it('sets web development mode and forwards CLI arguments without splitting paths', () => {
  const result = launch('web', ['--', '--pm2-home', '/tmp/my pm2', '--no-open']);
  expect(result.args).toEqual(['--pm2-home', '/tmp/my pm2', '--no-open']);
  expect(result.env).toMatchObject({
    NODE_ENV: 'development',
    SERVER_DEV_MODE: 'true',
    DEBUG: 'true',
  });
});

it('preserves the desktop backend debugger override and explicit sandbox opt-out', () => {
  expect(launch('desktop', []).env.PM2_CAPTAIN_BACKEND_DEBUG_PORT).toBe('9339');
  const result = launch('desktop', ['--no-sandbox'], { PM2_CAPTAIN_BACKEND_DEBUG_PORT: '9449' });
  expect(result.env.PM2_CAPTAIN_BACKEND_DEBUG_PORT).toBe('9449');
  expect(result.args).toEqual(['--no-sandbox']);
});
