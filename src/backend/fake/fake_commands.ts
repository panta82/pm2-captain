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
]);

/** A command as it is sent, before defaults are filled in. */
export type IFakeCommandInput = z.input<typeof FakeCommandSchema>;
export type IFakeCommand = z.infer<typeof FakeCommandSchema>;
