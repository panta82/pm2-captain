import { z } from 'zod';

import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IAppLifecycleMethods, IAppWaitForMethod } from '../lib/app';
import { FakeCommandSchema, IFakeCommand } from './fake_commands';
import { FakeTargetNotFoundError } from './fake_daemon';
import { FakeScenarioNotFoundError, InvalidFakeScenarioError } from './fake_scenario';

/** A log file sent as lines can be large. */
const COMMAND_BODY_LIMIT = 32 * 1024 * 1024;

/**
 * Fake mode's control surface: runs commands against the fake world and offers
 * them over HTTP. It only exists in a container that was created in fake mode.
 */
export function createFakeControl({
  settings,
  fakeWorld,
  daemonManager,
  captainLauncher,
  webServer,
  log,
}: IContainer) {
  // Captain's daemon list is part of what a scenario sets up, so a reset reads
  // it again. That takes the same steps as stopping and starting Captain.
  const reloadDaemons = async () => {
    await daemonManager.stop();
    await daemonManager.dispose();
    await daemonManager.initialize();
    await daemonManager.start();
  };

  return new (class FakeControl implements IAppLifecycleMethods {
    initialize = async () => {
      webServer.register(async routes => {
        // The same rules as /launch/daemon: the launch token as a bearer token,
        // and never a request that a web page made.
        routes.addHook('onRequest', async (request, reply) => {
          if (request.headers.origin) {
            return reply
              .status(403)
              .send({ error: 'Browser-originated fake commands are not allowed.' });
          }
          const authorization = request.headers.authorization;
          const candidate = authorization?.startsWith('Bearer ')
            ? authorization.slice(7)
            : undefined;
          if (!captainLauncher.authenticate(candidate)) {
            return reply.status(401).send({ error: 'Invalid PM2 Captain launch token.' });
          }
        });

        routes.get('/api/fake/state', async () => fakeWorld.state());

        routes.post(
          '/api/fake/commands',
          { bodyLimit: COMMAND_BODY_LIMIT },
          async (request, reply) => {
            const commands = z
              .array(FakeCommandSchema)
              .safeParse(Array.isArray(request.body) ? request.body : [request.body]);
            if (!commands.success) {
              return reply.status(400).send({ error: z.prettifyError(commands.error) });
            }
            try {
              await this.run(commands.data);
            } catch (error) {
              if (error instanceof InvalidFakeScenarioError) {
                return reply.status(400).send({ error: error.message });
              }
              if (
                error instanceof FakeTargetNotFoundError ||
                error instanceof FakeScenarioNotFoundError
              ) {
                return reply.status(404).send({ error: error.message });
              }
              throw error;
            }
            return { applied: commands.data.length };
          }
        );
      });
    };

    start = async (waitFor: IAppWaitForMethod) => {
      await waitFor('captainLauncher');
      console.log(
        `Fake mode: showing the "${settings.fake?.scenario}" scenario, not real PM2 daemons.\n`
      );
    };

    /** Applies the commands in order and stops at the first one that fails. */
    run = async (commands: IFakeCommand[]) => {
      for (const command of commands) {
        log.info({ type: command.type }, 'Fake command');
        if (command.type === 'world.reset') {
          await fakeWorld.reset(command.scenario);
          await reloadDaemons();
        } else {
          fakeWorld.apply(command);
        }
      }
    };
  })();
}

export default define({
  createFakeControl,
});
