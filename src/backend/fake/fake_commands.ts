import { z } from 'zod';

import {
  FakeDaemonFieldsSchema,
  FakeProcessCreationSchema,
  FakeProcessFieldsSchema,
  FakeScenarioSchema,
} from './fake_scenario';

const daemonKey = z.string().min(1);
/** A process name, or its PM2 ID as a number. */
const processReference = z.union([z.string().min(1), z.number().int().nonnegative()]);
const logChannel = z.enum(['out', 'err']);

/**
 * Everything that can be done to the fake world from outside. The command line,
 * the HTTP API and tests all send these. Fields are flat, so a command reads the
 * same as JSON and as `type daemon process key=value` on the command line.
 */
export const FakeCommandSchema = z.discriminatedUnion('type', [
  /** Starts the world and Captain's daemon list over. Without a scenario, the one Captain started with. */
  z.strictObject({
    type: z.literal('world.reset'),
    scenario: z.union([z.string().min(1), FakeScenarioSchema]).optional(),
  }),
  FakeDaemonFieldsSchema.extend({ type: z.literal('daemon.set'), daemon: daemonKey }),
  /** `process` is the name of the new process. */
  FakeProcessFieldsSchema.extend(FakeProcessCreationSchema.shape).extend({
    type: z.literal('process.add'),
    daemon: daemonKey,
    process: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal('process.remove'),
    daemon: daemonKey,
    process: processReference,
  }),
  FakeProcessFieldsSchema.extend({
    type: z.literal('process.set'),
    daemon: daemonKey,
    process: processReference,
  }),
  /** Prints lines now. `{n}` in a line is the number of the repeat. */
  z.strictObject({
    type: z.literal('log.emit'),
    daemon: daemonKey,
    process: processReference,
    channel: logChannel.default('out'),
    lines: z.array(z.string()).min(1),
    repeat: z.number().int().min(1).max(100_000).default(1),
  }),
  /** Changes the log file as if the lines were written before anyone looked. */
  z.strictObject({
    type: z.literal('log.history'),
    daemon: daemonKey,
    process: processReference,
    channel: logChannel.default('out'),
    lines: z.array(z.string()),
    mode: z.enum(['replace', 'append']).default('replace'),
  }),
  /** Without a channel, both log files. */
  z.strictObject({
    type: z.literal('log.rotate'),
    daemon: daemonKey,
    process: processReference,
    channel: logChannel.optional(),
  }),
  /**
   * Edits a daemon in Captain's stored list, as an editor or another Captain
   * would. A new PM2 home is a new location, so Captain reconnects.
   */
  z.strictObject({
    type: z.literal('registry.edit'),
    daemon: daemonKey,
    label: z.string().min(1).nullable().optional(),
    pm2Home: z.string().min(1).optional(),
  }),
  /** Removes a daemon from Captain's stored list. */
  z.strictObject({ type: z.literal('registry.remove'), daemon: daemonKey }),
  /** Adds a fake daemon back to Captain's stored list, as the scenario defines it. */
  z.strictObject({ type: z.literal('registry.add'), daemon: daemonKey }),
  /** Breaks the stored list: Captain keeps the daemons it last loaded and warns. */
  z.strictObject({
    type: z.literal('registry.fail'),
    reason: z.enum(['invalid', 'missing', 'unreadable']),
  }),
  /** Makes the stored list readable again, with the daemons it held before it broke. */
  z.strictObject({ type: z.literal('registry.recover') }),
  /** Puts the simulated desktop update into a state, as the real updater reports them. */
  z.strictObject({
    type: z.literal('update.set'),
    status: z.enum([
      'disabled',
      'idle',
      'checking',
      'available',
      'downloading',
      'downloaded',
      'installing',
      'error',
    ]),
    version: z.string().min(1).optional(),
    percent: z.number().min(0).max(100).optional(),
    installKind: z.enum(['appimage', 'deb', 'rpm', 'mac']).optional(),
    errorPhase: z.enum(['check', 'download', 'install']).optional(),
    errorMessage: z.string().min(1).optional(),
  }),
  /** What a simulated installation does when the user starts it. */
  z.strictObject({
    type: z.literal('update.install-outcome'),
    outcome: z.enum(['fail', 'stay']),
    message: z.string().min(1).optional(),
  }),
  z.strictObject({ type: z.literal('update.reset') }),
]);

/** A command whose fields do not fit together. Reported as a bad request. */
export class InvalidFakeCommandError extends Error {
  readonly code = 'INVALID_FAKE_COMMAND';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidFakeCommandError';
  }
}

/** The fake daemon registry is broken or missing, so it cannot be edited. */
export class FakeRegistryUnavailableError extends Error {
  readonly code = 'FAKE_REGISTRY_UNAVAILABLE';

  constructor() {
    super('The fake daemon registry is broken or missing. Send registry.recover first.');
    this.name = 'FakeRegistryUnavailableError';
  }
}

/** A command as it is sent, before defaults are filled in. */
export type IFakeCommandInput = z.input<typeof FakeCommandSchema>;
export type IFakeCommand = z.infer<typeof FakeCommandSchema>;
