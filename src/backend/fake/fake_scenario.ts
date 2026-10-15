import { promises as fs } from 'node:fs';
import libPath from 'node:path';
import { z } from 'zod';

import type { IProcessStatus } from '../../shared/contracts';

const FAKE_PROCESS_STATUSES = [
  'online',
  'stopping',
  'stopped',
  'launching',
  'errored',
  'one-launch-status',
  'unknown',
] as const satisfies readonly IProcessStatus[];

export const FAKE_LOG_PROFILES = ['timestamped', 'plain', 'json', 'stack', 'long'] as const;
export type IFakeLogProfile = (typeof FAKE_LOG_PROFILES)[number];

/** What a scenario or a command can set on a simulated process. */
export const FakeProcessFieldsSchema = z
  .strictObject({
    namespace: z.string().min(1),
    status: z.enum(FAKE_PROCESS_STATUSES),
    /** "captain" stands for the PID of this Captain, which makes the process Captain itself. */
    pid: z.union([z.number().int().positive(), z.literal('captain')]).nullable(),
    mode: z.enum(['fork', 'cluster']),
    /** Percent and bytes while the process is online. */
    cpu: z.number().min(0),
    memory: z.number().min(0),
    /** Sets the start time this far in the past. */
    uptimeMs: z.number().min(0),
    restarts: z.number().int().min(0),
    unstableRestarts: z.number().int().min(0),
    version: z.string().nullable(),
    watching: z.boolean(),
    script: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    interpreter: z.string(),
    nodeVersion: z.string(),
    exitCode: z.number().int().nullable(),
    cronRestart: z.string().nullable(),
    /** The same path for both makes a shared log file. */
    outLogPath: z.string().nullable(),
    errLogPath: z.string().nullable(),
    env: z.record(z.string(), z.string()),
    /** How long start, stop and restart take, passing through "launching" or "stopping". */
    actionDelayMs: z.number().int().min(0).max(60_000),
    /** The next start, stop or restart fails with this message. */
    nextActionError: z.string().nullable(),
    /** 0 to 1: how far CPU and memory wander around their values on every read. */
    metricJitter: z.number().min(0).max(1),
    /** Generated log entries per second while the process is online. 0 turns generation off. */
    logRate: z.number().min(0).max(5_000),
    logProfile: z.enum(FAKE_LOG_PROFILES),
    /** 0 to 1: the share of generated entries that go to stderr. */
    logErrorRatio: z.number().min(0).max(1),
  })
  .partial();
export type IFakeProcessFields = z.infer<typeof FakeProcessFieldsSchema>;

/** Only for a new process. */
export const FakeProcessCreationSchema = z.strictObject({
  /** More than one makes a cluster of processes with the same name. */
  instances: z.number().int().min(1).max(64).optional(),
  /** Generated log entries that already exist when the process appears. */
  history: z.number().int().min(0).max(100_000).optional(),
});

const FakeProcessInputSchema = FakeProcessFieldsSchema.extend(
  FakeProcessCreationSchema.shape
).extend({ name: z.string().min(1) });
export type IFakeProcessInput = z.infer<typeof FakeProcessInputSchema>;

/** What a scenario or a command can set on a simulated daemon. */
export const FakeDaemonFieldsSchema = z
  .strictObject({
    /** False: PM2 is not running there, or the server cannot be reached. */
    isUp: z.boolean(),
    /** Replaces the default reason shown while the daemon is down. */
    error: z.string().nullable(),
    connectDelayMs: z.number().int().min(0).max(60_000),
    /** Added to every PM2 call. */
    latencyMs: z.number().int().min(0).max(60_000),
    hostname: z.string().min(1),
    username: z.string().min(1),
  })
  .partial();
export type IFakeDaemonFields = z.infer<typeof FakeDaemonFieldsSchema>;

const FakeDaemonInputSchema = FakeDaemonFieldsSchema.extend({
  /** The name commands use for this daemon. */
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(['local', 'ssh']).optional(),
  pm2Home: z.string().min(1).optional(),
  sshArgs: z.array(z.string()).min(1).optional(),
  label: z.string().min(1).optional(),
  /** False keeps the daemon out of Captain's list, so it can be added by hand. */
  isRegistered: z.boolean().optional(),
  processes: z.array(FakeProcessInputSchema).optional(),
});
export type IFakeDaemonInput = z.infer<typeof FakeDaemonInputSchema>;

export const FakeScenarioSchema = z.strictObject({
  /** Seeds the generated logs, so the same scenario always starts the same. */
  seed: z.number().int().optional(),
  /**
   * Captain's daemon list was never set up, so it detects the local daemons
   * that are up instead of using `isRegistered`.
   */
  isFirstLaunch: z.boolean().optional(),
  daemons: z.array(FakeDaemonInputSchema),
});
export type IFakeScenario = z.infer<typeof FakeScenarioSchema>;

const MEGABYTE = 1024 * 1024;

const BUILT_IN_SCENARIOS: Record<string, () => IFakeScenario> = {
  /** One local daemon with a handful of processes in the common states. */
  basic: () => ({
    daemons: [
      {
        key: 'local',
        processes: [
          { name: 'api', cpu: 4.2, memory: 182 * MEGABYTE, logRate: 2, history: 300 },
          { name: 'worker', cpu: 1.1, memory: 96 * MEGABYTE, logRate: 0.5, history: 80 },
          { name: 'scheduler', status: 'stopped', exitCode: 0, history: 20 },
          {
            name: 'mailer',
            status: 'errored',
            restarts: 15,
            unstableRestarts: 15,
            exitCode: 1,
            logProfile: 'stack',
            logErrorRatio: 1,
            history: 12,
          },
        ],
      },
    ],
  }),

  /** One crowded daemon: clusters, namespaces, moving metrics and fast logs. */
  busy: () => ({
    daemons: [
      {
        key: 'local',
        processes: [
          {
            name: 'gateway',
            instances: 8,
            cpu: 22,
            memory: 310 * MEGABYTE,
            metricJitter: 0.4,
            logRate: 40,
            logProfile: 'json',
            history: 2_000,
          },
          ...['users', 'orders', 'billing', 'search', 'media', 'notifications'].map(name => ({
            name: `${name}-api`,
            namespace: 'services',
            instances: 4,
            cpu: 6,
            memory: 150 * MEGABYTE,
            metricJitter: 0.3,
            logRate: 5,
            history: 500,
          })),
          ...Array.from({ length: 16 }, (_, index) => ({
            name: `worker-${String(index + 1).padStart(2, '0')}`,
            namespace: 'workers',
            cpu: 35,
            memory: 420 * MEGABYTE,
            metricJitter: 0.6,
            logRate: 1,
            restarts: index % 5,
            history: 200,
          })),
          ...['cleanup', 'reports', 'backups', 'digest'].map(name => ({
            name: `cron-${name}`,
            namespace: 'cron',
            status: 'stopped' as const,
            cronRestart: '0 3 * * *',
            exitCode: 0,
            history: 40,
          })),
        ],
      },
    ],
  }),

  /** One daemon with every status and the awkward shapes of names and logs. */
  edge: () => ({
    daemons: [
      {
        key: 'local',
        processes: [
          ...FAKE_PROCESS_STATUSES.map(status => ({
            name: `status-${status}`,
            status,
            history: 10,
          })),
          {
            name: 'a-process-with-a-remarkably-long-name-that-has-to-be-truncated-somewhere',
            namespace: 'a-rather-long-namespace-too',
            version: '12.345.678-beta.9+build.20261012',
            history: 10,
          },
          { name: 'no-logs', outLogPath: '/dev/null', errLogPath: '/dev/null' },
          {
            name: 'shared-log',
            outLogPath: '/srv/local/.pm2/logs/shared-log.log',
            errLogPath: '/srv/local/.pm2/logs/shared-log.log',
            logErrorRatio: 0.5,
            history: 100,
          },
          { name: 'no-timestamps', logProfile: 'plain', logErrorRatio: 0.4, history: 100 },
          { name: 'json-logs', logProfile: 'json', history: 100 },
          { name: 'stack-traces', logProfile: 'stack', logErrorRatio: 0.5, history: 60 },
          { name: 'long-lines', logProfile: 'long', history: 60 },
          { name: 'restart-loop', restarts: 4_812, unstableRestarts: 15, uptimeMs: 1_200 },
          { name: 'slow-actions', actionDelayMs: 4_000 },
          { name: 'failing-actions', nextActionError: 'Process failed to launch: EADDRINUSE' },
          { name: 'pm2-captain', pid: 'captain' },
          {
            name: 'many-variables',
            env: Object.fromEntries(
              Array.from({ length: 60 }, (_, index) => [
                `SETTING_${index + 1}`,
                `value-${index + 1}`,
              ])
            ),
          },
        ],
      },
    ],
  }),

  /** Several daemons: local and remote, up and down, and one left to add by hand. */
  multi: () => ({
    daemons: [
      {
        key: 'local',
        processes: [
          { name: 'api', logRate: 1, history: 100 },
          { name: 'worker', history: 40 },
        ],
      },
      {
        key: 'blue',
        pm2Home: '/srv/pm2-blue',
        label: 'Blue stack',
        processes: [{ name: 'api', instances: 2, history: 50 }],
      },
      {
        key: 'staging',
        kind: 'ssh',
        sshArgs: ['deploy@staging.example.com'],
        hostname: 'staging-01',
        processes: [
          { name: 'api', logRate: 1, history: 100 },
          { name: 'queue', status: 'errored', restarts: 31, exitCode: 1, history: 30 },
        ],
      },
      {
        key: 'production',
        kind: 'ssh',
        sshArgs: ['-p', '2222', 'deploy@prod.example.com'],
        hostname: 'prod-01',
        isUp: false,
        error: 'ssh: connect to host prod.example.com port 2222: Connection timed out',
        processes: [{ name: 'api', instances: 4 }],
      },
      {
        key: 'spare',
        pm2Home: '/srv/pm2-spare',
        isRegistered: false,
        processes: [{ name: 'spare-app', history: 20 }],
      },
    ],
  }),

  /**
   * One process floods its log, with a full buffer of history from the start,
   * for following, pausing, filtering and highlighting under load.
   */
  firehose: () => ({
    daemons: [
      {
        key: 'local',
        processes: [
          {
            name: 'firehose',
            cpu: 64,
            memory: 512 * MEGABYTE,
            metricJitter: 0.3,
            logRate: 1_000,
            logErrorRatio: 0.05,
            history: 20_000,
          },
          { name: 'api', cpu: 4.2, memory: 182 * MEGABYTE, logRate: 2, history: 300 },
        ],
      },
    ],
  }),
};

export const DEFAULT_FAKE_SCENARIO = 'basic';

function parseScenario(value: unknown): IFakeScenario {
  const result = FakeScenarioSchema.safeParse(value);
  if (!result.success) {
    throw new InvalidFakeScenarioError(z.prettifyError(result.error));
  }
  const keys = result.data.daemons.map(daemon => daemon.key);
  const repeatedKey = keys.find((key, index) => keys.indexOf(key) !== index);
  if (repeatedKey) {
    throw new InvalidFakeScenarioError(`The daemon key "${repeatedKey}" is used twice.`);
  }
  return result.data;
}

/** Takes a built-in scenario name, a path to a JSON scenario, or a scenario itself. */
export async function loadFakeScenario(source: unknown): Promise<IFakeScenario> {
  if (typeof source !== 'string') {
    return parseScenario(source);
  }
  if (Object.hasOwn(BUILT_IN_SCENARIOS, source)) {
    return parseScenario(BUILT_IN_SCENARIOS[source]());
  }
  let content: string;
  try {
    content = await fs.readFile(libPath.resolve(source), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    throw new FakeScenarioNotFoundError(source);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new InvalidFakeScenarioError(`${source} is not valid JSON.`);
  }
  return parseScenario(parsed);
}

export class InvalidFakeScenarioError extends Error {
  readonly code = 'FAKE_SCENARIO_INVALID';

  constructor(detail: string) {
    super(`The fake scenario is not valid.\n${detail}`);
    this.name = 'InvalidFakeScenarioError';
  }
}

export class FakeScenarioNotFoundError extends Error {
  readonly code = 'FAKE_SCENARIO_NOT_FOUND';

  constructor(readonly scenario: string) {
    super(
      `There is no fake scenario "${scenario}". Use ${Object.keys(BUILT_IN_SCENARIOS).join(', ')}, or the path to a JSON scenario.`
    );
    this.name = 'FakeScenarioNotFoundError';
  }
}
