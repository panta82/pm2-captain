import { describe, expect, it } from 'vitest';

import {
  fieldsToSshArgs,
  splitArguments,
  sshArgsToFields,
} from '../../../../src/frontend/lib/ssh_arguments';

describe('ssh arguments', () => {
  it('splits quoted and escaped options', () => {
    expect(
      splitArguments(`-J jump  -o "ProxyCommand=ssh -W %h:%p gate" -i '/keys/my key'`)
    ).toEqual(['-J', 'jump', '-o', 'ProxyCommand=ssh -W %h:%p gate', '-i', '/keys/my key']);
    expect(splitArguments('-i /keys/my\\ key')).toEqual(['-i', '/keys/my key']);
  });

  it('rejects an unfinished quote or escape', () => {
    expect(() => splitArguments('-o "ProxyCommand=ssh')).toThrow();
    expect(() => splitArguments('-i /keys/my\\')).toThrow();
  });

  it('presents command-line arguments as form fields', () => {
    expect(sshArgsToFields(['-p', '2222', '-J', 'jump', 'deploy@example.com'])).toEqual({
      destination: 'deploy@example.com',
      port: '2222',
      options: '-J jump',
    });
    expect(sshArgsToFields(['tk-dev'])).toEqual({ destination: 'tk-dev', port: '', options: '' });
  });

  it('leaves a non-numeric -p value among the options', () => {
    expect(sshArgsToFields(['-o', '-p', 'tk-dev'])).toEqual({
      destination: 'tk-dev',
      port: '',
      options: '-o -p',
    });
  });

  it('round-trips arguments that need quoting', () => {
    const sshArgs = [
      '-o',
      'ProxyCommand=ssh -W %h:%p gate',
      '-i',
      `/keys/it's "mine"`,
      '-i',
      'C:\\keys\\id',
      '-p',
      '2222',
      'deploy@example.com',
    ];

    expect(fieldsToSshArgs(sshArgsToFields(sshArgs))).toEqual(sshArgs);
  });
});
