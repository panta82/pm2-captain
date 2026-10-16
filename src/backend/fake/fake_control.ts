import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { z } from 'zod';

import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IAppLifecycleMethods, IAppWaitForMethod } from '../lib/app';
import {
  FakeCommandSchema,
  FakeRegistryUnavailableError,
  IFakeCommand,
  InvalidFakeCommandError,
} from './fake_commands';
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
  sessionAuth,
  webServer,
  log,
}: IContainer) {
  // A desktop backend has an in-memory launch token on a random port. To be
  // controlled from a terminal it writes its address and a separate token that
  // only these fake routes accept into a private file in the app's profile.
  const controlFile = settings.runtime === 'desktop' ? (settings.fake?.controlFile ?? null) : null;
  const controlToken = controlFile ? randomBytes(32).toString('base64url') : null;

  const isControlToken = (candidate: string | undefined) => {
    if (!controlToken || !candidate) {
      return false;
    }
    const left = Buffer.from(candidate);
    const right = Buffer.from(controlToken);
    return left.length === right.length && timingSafeEqual(left, right);
  };

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
          if (!sessionAuth.authenticate(candidate) && !isControlToken(candidate)) {
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
              if (
                error instanceof InvalidFakeScenarioError ||
                error instanceof InvalidFakeCommandError
              ) {
                return reply.status(400).send({ error: error.message });
              }
              if (error instanceof FakeRegistryUnavailableError) {
                return reply.status(409).send({ error: error.message });
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
      // In the terminal, after the launcher's banner.
      await waitFor(settings.runtime === 'cli' ? 'captainLauncher' : 'webServer');
      if (controlFile && controlToken) {
        const temporaryPath = `${controlFile}.${process.pid}.tmp`;
        await fs.writeFile(
          temporaryPath,
          `${JSON.stringify({ baseURL: webServer.baseURL, token: controlToken })}\n`,
          { mode: 0o600 }
        );
        await fs.rename(temporaryPath, controlFile);
      }
      console.log(
        `Fake mode: showing the "${settings.fake?.scenario}" scenario, not real PM2 daemons.\n`
      );
    };

    stop = async () => {
      if (controlFile) {
        await fs.rm(controlFile, { force: true });
      }
    };

    // An app disposed while it is still starting skips stop(), and disposes
    // only after the start, which may have written the control file, is done.
    dispose = () => this.stop();

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
