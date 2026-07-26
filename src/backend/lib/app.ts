import { z } from 'zod';

import { IContainer } from '../container';
import { assert } from '../framework/assertions';
import { IServiceIdentifier, define } from '../framework/dependency_injection';
import { Enum } from '../framework/enum';
import { CustomError } from '../framework/errors';
import { IPromtzel, arrToStr, promtzel, waitFor } from '../framework/tools';
import { ReplaceProperty } from '../framework/types';

export const APP_LIFECYCLE_METHOD_NAMES = new Enum('initialize', 'start', 'stop', 'dispose');
export type IAppLifecycleMethodName = (typeof APP_LIFECYCLE_METHOD_NAMES.tuple)[number];

export const APP_STAGES = new Enum('inject', 'idle', 'ready', 'active');
export type IAppStage = (typeof APP_STAGES.tuple)[number];

const KILL_SIGNALS = ['SIGTERM', 'SIGINT'];

/**
 * Lifecycle method can be sync or async. If it returns a function, it will be executed after all the other functions
 * in that stage have been executed, in "first come first serve fashion". This will be happening until all methods
 * return void.
 */
export type IAppWaitForMethod = (...serviceIdentifiers: IServiceIdentifier[]) => Promise<void>;
type IAppLifecycleMethodResult = void | IAppLifecycleMethod | Promise<void | IAppLifecycleMethod>;
type IAppLifecycleMethod = (waitFor: IAppWaitForMethod) => IAppLifecycleMethodResult;
export type IAppLifecycleMethods = { [method in IAppLifecycleMethodName]?: IAppLifecycleMethod };

export type IAppEnrollment = IServiceIdentifier | '*';

export const AppStateSchema = z.object({
  instanceId: z.string(),
  stage: z.enum(APP_STAGES.tuple),
  pid: z.number(),
  createdAt: z.date(),
  initializedAt: z.date().nullable(),
  startedAt: z.date().nullable(),
  enrollments: z.set(z.union([z.string(), z.literal('*')])),
  serviceSequence: z.array(z.string()).nullable(),
});
export type IAppState = ReplaceProperty<
  z.infer<typeof AppStateSchema>,
  'serviceSequence',
  IServiceIdentifier[] | null
>;

interface IAppSequenceStateWaitingRecord {
  identifier: IServiceIdentifier;
  waitingFor: IServiceIdentifier[];
  waitPromise: IPromtzel<void>;
  lifecycleMethodPromise: Promise<IAppLifecycleMethodResult>;
}

interface IAppSequenceState {
  methodName: IAppLifecycleMethodName;
  reverse: boolean;
  cycle: number;
  identifierMethods: Partial<Record<IServiceIdentifier, IAppLifecycleMethod>>;
  currentCycle: IServiceIdentifier[];
  nextCycle: IServiceIdentifier[];
  waiting: Map<IServiceIdentifier, IAppSequenceStateWaitingRecord>;
  completed: Set<IServiceIdentifier>;
  promise: IPromtzel<void>;
}

export function createApp({ log, container }: IContainer) {
  const state: IAppState = {
    instanceId: process.hrtime.bigint().toString(),
    stage: 'idle',
    pid: process.pid,
    createdAt: new Date(),
    initializedAt: null,
    startedAt: null,
    enrollments: new Set(),
    serviceSequence: null,
  };

  let _runningSequence: IAppSequenceState | null = null;

  return new (class App {
    get state() {
      return state;
    }

    _assertEnrollmentsNotClosed = () => {
      if (state.serviceSequence) {
        throw new EnrollmentsClosedError();
      }
    };

    enroll = (...serviceIdentifiers: IServiceIdentifier[]) => {
      this._assertEnrollmentsNotClosed();
      for (const serviceIdentifier of serviceIdentifiers) {
        state.enrollments.add(serviceIdentifier);
      }
    };

    enrollAll = () => {
      this._assertEnrollmentsNotClosed();
      state.enrollments.add('*');
    };

    _ensureServiceSequenceFinalized = () => {
      if (state.serviceSequence) {
        // Already finalized
        return;
      }

      if (state.enrollments.size === 0) {
        // Nothing was added. Default to everything
        this.enrollAll();
      }

      state.serviceSequence = [];
      const star = state.enrollments.has('*');
      for (const identifier of container.identifiers) {
        if ((identifier as any) === 'app') {
          // No self-enrollment
          continue;
        }
        if (star || state.enrollments.has(identifier)) {
          state.serviceSequence.push(identifier);
        }
      }
      log.debug(`Service sequence initialized: ${arrToStr(state.serviceSequence)}`);
    };

    _runSequence = async (methodName: IAppLifecycleMethodName, reverse: boolean) => {
      if (_runningSequence) {
        await _runningSequence.promise;
      }

      try {
        _runningSequence = {
          reverse,
          cycle: 1,
          methodName,
          identifierMethods: {},
          currentCycle: [],
          nextCycle: [],
          waiting: new Map(),
          completed: new Set(),
          promise: promtzel(),
        };

        this._ensureServiceSequenceFinalized();

        const doWaitFor = async (
          identifier: IServiceIdentifier,
          lifecycleMethodPromise: Promise<IAppLifecycleMethodResult>,
          waitingFor: IServiceIdentifier[]
        ) => {
          assert(!_runningSequence!.waiting.has(identifier), `Already waiting for ${identifier}`);
          const waitPromise = promtzel<void>();
          _runningSequence!.waiting.set(identifier, {
            identifier,
            waitingFor,
            lifecycleMethodPromise,
            waitPromise,
          });
          await waitPromise;
        };

        const sequence = state.serviceSequence!.slice();
        if (reverse) {
          sequence.reverse();
        }

        for (const identifier of sequence) {
          const instance = (container as any)[identifier];
          assert(instance, `Service not found: ${identifier}`);

          if (instance[methodName]) {
            _runningSequence.identifierMethods[identifier] = instance[methodName].bind(instance);
            _runningSequence.currentCycle.push(identifier);
          } else {
            _runningSequence.completed.add(identifier);
          }
        }

        while (_runningSequence.currentCycle.length) {
          log.debug(
            `Running "${methodName}" on services ${arrToStr(_runningSequence.currentCycle)}${
              _runningSequence.cycle > 1 ? ` (cycle ${_runningSequence.cycle})` : ''
            }...`
          );
          for (const identifier of _runningSequence.currentCycle) {
            let lifecycleMethodPromise: Promise<IAppLifecycleMethodResult>;
            const waitingJob = _runningSequence.waiting.get(identifier);
            if (waitingJob) {
              // Stop waiting, resume previous promise
              _runningSequence.waiting.delete(identifier);
              lifecycleMethodPromise = waitingJob.lifecycleMethodPromise;
              waitingJob.waitPromise.resolve();
            } else {
              lifecycleMethodPromise = Promise.resolve().then(() =>
                _runningSequence!.identifierMethods[identifier]!(
                  (...waitingForIdentifiers: IServiceIdentifier[]) =>
                    doWaitFor(identifier, lifecycleMethodPromise, waitingForIdentifiers)
                )
              );
            }

            const waitForWaitingPromise = waitFor(
              () => _runningSequence!.waiting.get(identifier),
              5
            );
            const waitResult = await Promise.race([lifecycleMethodPromise, waitForWaitingPromise]);
            if (
              waitResult &&
              typeof waitResult === 'object' &&
              _runningSequence.waiting.get(identifier) === waitResult
            ) {
              // The lifecycle method has called waitFor(). We skip out of the loop for now.
              continue;
            }

            if (typeof waitResult === 'function') {
              _runningSequence.nextCycle.push(identifier);
              _runningSequence.identifierMethods[identifier] = waitResult;
            } else {
              // We are done with this
              _runningSequence.completed.add(identifier);
            }
          }

          if (_runningSequence.waiting.size > 0) {
            // Try to finish some of the waiting jobs
            for (const waitingJob of _runningSequence.waiting.values()) {
              const stillWaiting = waitingJob.waitingFor.some(
                identifier => !_runningSequence!.completed.has(identifier)
              );
              if (!stillWaiting) {
                // If we are done waiting, we can resume the lifecycle method
                _runningSequence.nextCycle.push(waitingJob.identifier);
              }
            }
          }

          _runningSequence.currentCycle = _runningSequence.nextCycle;
          _runningSequence.nextCycle = [];
          _runningSequence.cycle++;
        }

        if (_runningSequence.waiting.size > 0) {
          // These jobs never got resolved. There is a dead loop among waiting jobs.
          for (const waitingJob of _runningSequence.waiting.values()) {
            const conflictIdentifiers = waitingJob.waitingFor.filter(identifier =>
              _runningSequence!.waiting.has(identifier)
            );
            if (conflictIdentifiers.length) {
              throw new CircularWaitError(waitingJob.identifier, conflictIdentifiers);
            }
          }
          // Just in case we haven't thrown any
          throw new Error(
            `Failed wait among services: ${arrToStr(Array.from(_runningSequence.waiting.keys()))}`
          );
        }

        _runningSequence?.promise?.resolve();
      } catch (err) {
        _runningSequence?.promise?.reject(err);
        throw err;
      } finally {
        _runningSequence = null;
      }
    };

    initialize = async (): Promise<boolean> => {
      if (state.stage !== 'idle') {
        return false;
      }

      if (log.isLevelEnabled('debug')) {
        this._ensureServiceSequenceFinalized();
        log.debug(`Initialization sequence: ${arrToStr(state.serviceSequence)}`);
      }

      await this._runSequence('initialize', false);
      log.info(`Initialized`);
      state.stage = 'ready';
      state.initializedAt = new Date();
      return true;
    };

    start = async (): Promise<boolean> => {
      if (state.stage === 'active') {
        return false;
      }

      if (state.stage === 'idle') {
        await this.initialize();
      }

      await this._runSequence('start', false);
      log.info(`Started`);
      state.stage = 'active';
      state.startedAt = new Date();
      return true;
    };

    stop = async () => {
      if (state.stage !== 'active') {
        return false;
      }

      await this._runSequence('stop', true);
      log.info(`Stopped`);
      state.stage = 'ready';
    };

    dispose = async () => {
      if (state.stage === 'idle') {
        return false;
      }

      if (state.stage === 'active') {
        await this.stop();
      }

      await this._runSequence('dispose', true);
      log.info(`Disposed`);
      state.stage = 'idle';
    };

    attachSignalHandlers() {
      KILL_SIGNALS.forEach(signal => {
        process.on(signal, async () => {
          try {
            log.warn(`Received kill signal: ${signal}`);
            await this.kill(0);
          } catch (err) {
            log.error(err);
          }
        });
      });
    }

    /**
     * Stop the app and exit with given code. Returns a promise that is guaranteed not to reject.
     */
    async kill(exitCode = 128) {
      try {
        await this.dispose();
      } catch (err) {
        log.error(err);
      } finally {
        log.info(`Exit code: ${exitCode}`);
        process.exit(exitCode);
      }
    }
  })();
}

export default define({
  createApp,
});

class AppError extends CustomError {}

export class EnrollmentsClosedError extends AppError {
  constructor() {
    super('Service sequence has been finalized, enrollments are closed');
  }
}

export class CircularWaitError extends AppError {
  constructor(identifier: string, conflictIdentifiers: string[]) {
    super(
      `Circular wait by service "${identifier}" for service(s): ${arrToStr(
        conflictIdentifiers,
        '"'
      )}`
    );
  }
}
