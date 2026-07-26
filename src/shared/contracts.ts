export type ProcessStatus =
  | 'online'
  | 'stopping'
  | 'stopped'
  | 'launching'
  | 'errored'
  | 'one-launch-status'
  | 'unknown';

export type ProcessAction = 'start' | 'stop' | 'restart';
export type LogView = 'combined' | 'out' | 'err';
export type LogChannel = 'out' | 'err' | 'shared';

export interface ProcessSummary {
  pmId: number;
  name: string;
  namespace: string;
  status: ProcessStatus;
  pid: number | null;
  mode: string;
  cpu: number | null;
  memory: number | null;
  uptime: number | null;
  restarts: number;
  unstableRestarts: number;
  version: string | null;
  watching: boolean;
  isCaptain: boolean;
}

export interface ProcessDetail extends ProcessSummary {
  script: string | null;
  args: string[];
  cwd: string | null;
  interpreter: string | null;
  nodeVersion: string | null;
  instances: number | null;
  createdAt: number | null;
  exitCode: number | null;
  cronRestart: string | null;
  outLogPath: string | null;
  errLogPath: string | null;
}

export interface ProcessListResult {
  hostLabel: string;
  processes: ProcessSummary[];
}

export interface LogEntry {
  id: string;
  pmId: number;
  processName: string;
  channel: LogChannel;
  text: string;
  timestamp: number | null;
  sequence: number;
}

export interface LogPage {
  entries: LogEntry[];
  cursor: string | null;
  hasMore: boolean;
  approximateOrder: boolean;
  sharedFile: boolean;
  rotated: boolean;
}

export interface LogStreamEvent {
  type: 'log' | 'daemon-status';
  entry?: LogEntry;
  connected?: boolean;
  message?: string;
}
