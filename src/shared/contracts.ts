export type IProcessStatus =
  | 'online'
  | 'stopping'
  | 'stopped'
  | 'launching'
  | 'errored'
  | 'one-launch-status'
  | 'unknown';

export type IProcessAction = 'start' | 'stop' | 'restart';
export type ILogView = 'combined' | 'out' | 'err';
export type ILogChannel = 'out' | 'err' | 'shared';

export interface IProcessSummary {
  pmId: number;
  name: string;
  namespace: string;
  status: IProcessStatus;
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

export interface IProcessDetail extends IProcessSummary {
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

export interface IProcessListResult {
  hostLabel: string;
  processes: IProcessSummary[];
}

export interface ILogEntry {
  id: string;
  pmId: number;
  processName: string;
  channel: ILogChannel;
  text: string;
  timestamp: number | null;
  sequence: number;
}

export interface ILogPage {
  entries: ILogEntry[];
  cursor: string | null;
  hasMore: boolean;
  approximateOrder: boolean;
  sharedFile: boolean;
  rotated: boolean;
}

export interface ILogStreamEvent {
  type: 'log' | 'daemon-status';
  entry?: ILogEntry;
  connected?: boolean;
  message?: string;
}
