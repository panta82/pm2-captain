import { TalentedParsedArgs, formatters, talentedArgs } from 'talented-args';

import {
  DEFAULT_FAKE_PORT,
  DEFAULT_PORT,
  PACKAGE_VERSION,
  defaultConfigDir,
} from './backend_settings';
import { describeFakeCommands } from './fake/fake_cli';
import { DEFAULT_FAKE_SCENARIO } from './fake/fake_scenario';

/** The `pm2-captain` command line. The desktop app never parses it. */
export const CLI_PROGRAM = talentedArgs(
  {
    name: 'PM2 Captain',
    description: 'A local web control room for PM2 processes and logs',
    version: `v${PACKAGE_VERSION}`,
    executable: 'pm2-captain',
    // Without a command, Captain serves the UI; the commands only add to that.
    missingCommandPolicy: 'none',
  },
  ta => ({
    port: ta
      .arg(
        ['-p', '--port'],
        `HTTP port (default: ${DEFAULT_PORT}, or ${DEFAULT_FAKE_PORT} in fake mode)`,
        Number
      )
      .label('number'),
    pm2Home: ta
      .arg(
        '--pm2-home',
        'Add the PM2 home at this path. With "ssh", the path is on the remote server.'
      )
      .label('path'),
    open: ta
      .flag(
        '--open',
        'Always open a browser tab, or never with --no-open. By default a restart reuses the tab that is already open.'
      )
      .negatable(),
    noAuth: ta.flag(
      '--no-auth',
      'Disable Captain authentication (use behind an authenticated proxy)'
    ),
    fakeScenario: ta
      .arg(
        '--fake',
        'Show simulated PM2 daemons instead of real ones, for testing. Scenarios: basic, busy, edge, multi, firehose, or the path to a JSON file.'
      )
      .label('scenario')
      .preset(DEFAULT_FAKE_SCENARIO),
    ssh: ta.command(
      'ssh',
      {
        summary: 'Add the PM2 daemon on a remote server',
        details:
          'Adds the PM2 daemon on a server you reach with your system SSH client. Captain uses its configuration, keys, agent, and jump hosts, and does not install anything on the remote server.',
      },
      {
        sshArgs: ta
          .rest('--ssh-args', 'Passed to your system SSH client, such as "-p 2222 user@host"')
          .required(),
      }
    ),
    fake: ta.command(
      'fake',
      {
        summary: 'Control the Captain that runs in fake mode',
        details: [
          'Sends a command to the Captain that runs in fake mode on the same port. With "--control <file>" first, sends it to the desktop app in fake mode that wrote that file.',
          '',
          'The short form is "<type> [daemon [process]] [field=value …] [-- line …]". A daemon is named by its key in the scenario, and a process by its name or PM2 ID. A value is read as JSON when it is JSON, otherwise as text. A JSON command, or an array of them, works too.',
        ].join('\n'),
      },
      {
        command: ta.rest('--command', 'The fake command, in the short form or as JSON').required(),
      }
    ),
  })
).customize({
  formatSection: (content, { type, command, interactive }) => {
    // The examples and the fake command list are for help. The editor has no room for them.
    if (type !== 'footer' || interactive) {
      return;
    }
    const { title, row, text } = formatters;
    if (command === null) {
      content.push(
        title('Remote server'),
        row('pm2-captain ssh tk-dev', 'Add the PM2 daemon on tk-dev'),
        row(
          'pm2-captain --port 3213 ssh -p 2222 user@example.com',
          'Captain on port 3213, SSH on port 2222'
        ),
        row(
          'pm2-captain --pm2-home /srv/pm2 ssh deploy@example.com',
          'Use a PM2 home other than the remote default'
        ),
        title('Fake mode'),
        row('pm2-captain --fake busy', 'Show the "busy" scenario'),
        row('pm2-captain fake state', 'Print what the fake Captain shows'),
        row('pm2-captain fake --help', 'List everything a fake Captain can be told to do'),
        title('Daemons'),
        text(
          `Daemons are saved in ${defaultConfigDir()}/daemons.json. On the first launch, Captain fills that list with the PM2 daemons it finds on this computer.`
        )
      );
    } else if (command === 'fake') {
      content.push(
        title('Fake commands'),
        ...describeFakeCommands().map(fake => row(fake.name, fake.description)),
        title('Examples'),
        row('pm2-captain fake process.set local api status=errored', 'Make a process fail'),
        row(
          'pm2-captain fake log.emit local api channel=err -- "Something broke"',
          'Print a line to stderr'
        ),
        row('pm2-captain fake --control <file> state', 'Ask the desktop app in fake mode')
      );
    }
  },
});

export type ICliArgs = TalentedParsedArgs<typeof CLI_PROGRAM>;
