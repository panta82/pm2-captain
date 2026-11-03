import { formatters, talentedArgs } from 'talented-args';

/** Shared development options; application arguments follow a second `--`. */
export const createDevProgram = target => {
  const executable = `npm run ${target}:dev --`;
  const isDesktop = target === 'desktop';
  const debugPort = isDesktop ? 9338 : 9229;
  const debugProcess = isDesktop ? 'Electron main' : 'the web backend';
  const program = talentedArgs(
    {
      name: `PM2 Captain ${target} development`,
      description: 'Run from source with hot reload. Uses real PM2 daemons by default.',
      executable,
    },
    ta => ({
      fakeScenario: ta
        .arg(
          '--fake-data',
          'Use simulated daemons: basic, busy, edge, multi, firehose, or a JSON file.'
        )
        .label('scenario')
        .preset('basic'),
      inspect: ta
        .arg(
          '--inspect',
          `Enable the debugger for ${debugProcess} (default port: ${debugPort}).`,
          parseDebugPort
        )
        .label('port')
        .preset(String(debugPort)),
      inspectBrk: ta
        .arg(
          '--inspect-brk',
          `Pause ${debugProcess} until a debugger attaches (default port: ${debugPort}).`,
          parseDebugPort
        )
        .label('port')
        .preset(String(debugPort)),
      ...(isDesktop
        ? { noSandbox: ta.flag('--no-sandbox', 'Run Electron without the Chromium sandbox.') }
        : {}),
      forwardedArgs: ta
        .arg('--args', `Arguments for ${isDesktop ? 'Electron' : 'the Captain CLI'}, after --.`)
        .multiple()
        .positional()
        .default([]),
    })
  );
  return program.customize({
    formatSection: (content, { type, interactive }) => {
      if (type !== 'footer' || interactive) {
        return;
      }
      content.push(
        formatters.title('Examples'),
        formatters.row(`npm run ${target}:dev`, 'Use the real daemon registry'),
        formatters.row(`${executable} --fake-data multi`, 'Use the multi scenario'),
        formatters.row(`${executable} --fake-data --inspect-brk`, 'Debug with simulated daemons'),
        formatters.row(`${executable} --interactive`, 'Choose options interactively'),
        formatters.row(
          `${executable} -- ${isDesktop ? '--remote-debugging-port=9340' : '--port 3216 --no-open'}`,
          `Pass arguments to ${isDesktop ? 'Electron' : 'Captain'}`
        )
      );
      if (isDesktop) {
        content.push(
          formatters.text(
            'The backend debugger uses port 9339. Override it with PM2_CAPTAIN_BACKEND_DEBUG_PORT.'
          )
        );
      }
    },
  });
};

const parseDebugPort = value => {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port > 65535) {
    throw new Error('Debugger port must be an integer between 0 and 65535.');
  }
  return port;
};

/** Translate dev flags to the child process without changing the published CLI. */
export const createDevLaunch = (target, options, environment) => {
  if (options.inspect !== undefined && options.inspectBrk !== undefined) {
    throw new Error('Choose either --inspect or --inspect-brk.');
  }
  const debugArgs =
    options.inspectBrk !== undefined
      ? [`--inspect-brk=${options.inspectBrk}`]
      : options.inspect !== undefined
        ? [`--inspect=${options.inspect}`]
        : [];
  // Ignore inherited fake scenarios so dev launches use real daemons unless
  // --fake-data is supplied.
  const { PM2_CAPTAIN_DESKTOP_FAKE: ignoredScenario, ...env } = environment;
  if (target === 'desktop') {
    return {
      debugArgs,
      args: [...(options.noSandbox ? ['--no-sandbox'] : []), ...options.forwardedArgs],
      env: {
        ...env,
        PM2_CAPTAIN_BACKEND_DEBUG_PORT: env.PM2_CAPTAIN_BACKEND_DEBUG_PORT || '9339',
        ...(options.fakeScenario === undefined
          ? {}
          : { PM2_CAPTAIN_DESKTOP_FAKE: options.fakeScenario }),
      },
    };
  }
  return {
    debugArgs,
    args: [
      ...(options.fakeScenario === undefined ? [] : ['--fake', options.fakeScenario]),
      ...options.forwardedArgs,
    ],
    env: { ...env, NODE_ENV: 'development', SERVER_DEV_MODE: 'true', DEBUG: 'true' },
  };
};

/** Print help or usage errors before starting any builds, watchers or processes. */
export const readDevLaunch = async target => {
  const options = await createDevProgram(target).parseOrDie();
  try {
    return createDevLaunch(target, options, process.env);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
};
