import type { ProcessDescription } from 'pm2';

import {
  IProcessAction,
  IProcessDetail,
  IProcessStatus,
  ISingleDaemonProcessListResult,
} from '../../shared/contracts';
import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { Pm2DaemonUnavailableError } from '../lib/pm2_client';

const PM2_ENVIRONMENT_KEYS = new Set([
  'args',
  'automation',
  'autorestart',
  'autostart',
  'axm_actions',
  'axm_dynamic',
  'axm_monitor',
  'axm_options',
  'command',
  'created_at',
  'env',
  'exec_interpreter',
  'exec_mode',
  'exit_code',
  'filter_env',
  'instance_var',
  'instances',
  'kill_retry_time',
  'merge_logs',
  'MODULE_DEBUG',
  'name',
  'node_args',
  'pm_cwd',
  'pm_err_log_path',
  'pm_exec_path',
  'pm_id',
  'pm_out_log_path',
  'pm_pid_path',
  'pm_uptime',
  'pmx',
  'pmx_module',
  'prev_restart_delay',
  'restart_time',
  'status',
  'stop_exit_codes',
  'treekill',
  'unstable_restart',
  'unstable_restarts',
  'username',
  'versioning',
  'vizion',
  'vizion_runing',
  'watch',
  'windowsHide',
]);

export class ProcessNotFoundError extends Error {
  readonly code = 'PM2_PROCESS_NOT_FOUND';

  constructor(readonly pmId: number) {
    super(`PM2 process ${pmId} was not found`);
    this.name = 'ProcessNotFoundError';
  }
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === 'string' && value.length) {
    return value.split(' ');
  }
  return [];
}

export function createProcessManager({ pm2Daemon, log, settings }: IContainer) {
  const actionQueues = new Map<number, Promise<unknown>>();

  const normalize = (
    description: ProcessDescription,
    includeEnvironment = false
  ): IProcessDetail => {
    const environment = (description.pm2_env || {}) as Record<string, any>;
    const status = (environment.status || 'unknown') as IProcessStatus;
    const startedAt = typeof environment.pm_uptime === 'number' ? environment.pm_uptime : null;

    return {
      daemonId: settings?.runtimeDaemonId || 'local',
      connectionId: settings?.runtimeConnectionId || '',
      pmId: Number(environment.pm_id ?? -1),
      name: environment.name || description.name || 'unnamed',
      namespace: environment.namespace || 'default',
      status,
      pid: typeof description.pid === 'number' && description.pid > 0 ? description.pid : null,
      mode: environment.exec_mode === 'cluster_mode' ? 'cluster' : 'fork',
      cpu: typeof description.monit?.cpu === 'number' ? description.monit.cpu : null,
      memory: typeof description.monit?.memory === 'number' ? description.monit.memory : null,
      uptime: status === 'online' && startedAt ? Math.max(0, Date.now() - startedAt) : null,
      restarts: Number(environment.restart_time || 0),
      unstableRestarts: Number(environment.unstable_restarts || 0),
      version: typeof environment.version === 'string' ? environment.version : null,
      watching: Boolean(environment.watch),
      isCaptain: pm2Daemon.isLocal && description.pid === global.process.pid,
      script: typeof environment.pm_exec_path === 'string' ? environment.pm_exec_path : null,
      args: stringArray(environment.args),
      cwd: typeof environment.pm_cwd === 'string' ? environment.pm_cwd : null,
      interpreter:
        typeof environment.exec_interpreter === 'string' ? environment.exec_interpreter : null,
      nodeVersion: typeof environment.node_version === 'string' ? environment.node_version : null,
      instances: typeof environment.instances === 'number' ? environment.instances : null,
      createdAt: typeof environment.created_at === 'number' ? environment.created_at : startedAt,
      exitCode: typeof environment.exit_code === 'number' ? environment.exit_code : null,
      cronRestart: typeof environment.cron_restart === 'string' ? environment.cron_restart : null,
      outLogPath:
        typeof environment.pm_out_log_path === 'string' ? environment.pm_out_log_path : null,
      errLogPath:
        typeof environment.pm_err_log_path === 'string' ? environment.pm_err_log_path : null,
      ...(includeEnvironment
        ? {
            environment: Object.entries(environment)
              .filter(
                ([name, value]) =>
                  !PM2_ENVIRONMENT_KEYS.has(name) &&
                  value !== null &&
                  value !== undefined &&
                  typeof value !== 'object'
              )
              .map(([name, value]) => {
                const stringValue = String(value);
                return {
                  name,
                  value: stringValue,
                  isDivergent:
                    pm2Daemon.isLocal &&
                    global.process.env[name] !== undefined &&
                    global.process.env[name] !== stringValue,
                };
              })
              .sort((left, right) => left.name.localeCompare(right.name)),
          }
        : {}),
    };
  };

  return new (class ProcessManager {
    list = async (): Promise<ISingleDaemonProcessListResult> => {
      const processes = await pm2Daemon.list();
      const identity = pm2Daemon.identity;
      if (!identity) {
        throw new Pm2DaemonUnavailableError();
      }
      const { hostname, username } = identity;
      return {
        hostname,
        username,
        hostLabel: `${username}@${hostname}`,
        processes: processes
          .map(description => normalize(description))
          .map(
            ({
              script,
              args,
              cwd,
              interpreter,
              nodeVersion,
              instances,
              createdAt,
              exitCode,
              cronRestart,
              outLogPath,
              errLogPath,
              environment,
              ...summary
            }) => summary
          )
          .sort((left, right) => left.pmId - right.pmId),
      };
    };

    detail = async (pmId: number, includeEnvironment = false): Promise<IProcessDetail> => {
      const result = await pm2Daemon.describe(pmId);
      if (!result.length) {
        throw new ProcessNotFoundError(pmId);
      }
      return normalize(result[0], includeEnvironment);
    };

    /**
     * `assertCurrent` runs when the action's turn comes, right before it is sent
     * to PM2, and can still refuse it.
     */
    action = async (pmId: number, action: IProcessAction, assertCurrent?: () => void) => {
      const process = await this.detail(pmId);
      if (action === 'stop' && process.isCaptain) {
        throw new Error('PM2 Captain cannot stop itself');
      }

      const previous = actionQueues.get(pmId) || Promise.resolve();
      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          assertCurrent?.();
          log.info({ pmId, action }, `PM2 ${action} requested`);
          if (action === 'start') {
            return pm2Daemon.startProcess(pmId);
          }
          if (action === 'stop') {
            return pm2Daemon.stopProcess(pmId);
          }
          if (process.isCaptain) {
            setTimeout(() => {
              void pm2Daemon.restartProcess(pmId).catch(error => {
                log.error({ error, pmId }, 'Captain self-restart failed');
              });
            }, 350);
            return { accepted: true, reconnecting: true };
          }
          return pm2Daemon.restartProcess(pmId);
        })
        .finally(() => {
          if (actionQueues.get(pmId) === operation) {
            actionQueues.delete(pmId);
          }
        });
      actionQueues.set(pmId, operation);
      await operation;
      return { accepted: true, reconnecting: process.isCaptain && action === 'restart' };
    };
  })();
}

export default define({
  createProcessManager,
});
