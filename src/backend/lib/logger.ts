import pino, { LoggerOptions } from 'pino';

import { IContainer } from '../container';
import { IServiceInfoBase, define } from '../framework/dependency_injection';

export function createLoggerOptions(debug = false): LoggerOptions {
  return {
    level: debug ? 'debug' : 'info',

    transport: debug
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            messageFormat: '{msg}',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
    // Standard timestamp format for all logs
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

export function createLogger({ settings }: Pick<IContainer, 'settings'>) {
  const instance = pino(createLoggerOptions(settings.debug));
  return instance;
}

export type ILogger = ReturnType<typeof createLogger>;

export default define({
  createLogger,
});

export const defaultLog = pino(createLoggerOptions(false));

// *********************************************************************************************************************

export function createLog({ logger }: IContainer, target: IServiceInfoBase) {
  return target
    ? logger.child(
        {
          service: target.name,
        },
        {
          msgPrefix: `[${target.name}]`,
        }
      )
    : logger;
}

export const logDefinition = define({
  createLog,
  injection: 'targeted',
});
