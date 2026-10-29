export type IProcessStatus =
  'online' | 'stopping' | 'stopped' | 'launching' | 'errored' | 'one-launch-status' | 'unknown';

export type IProcessAction = 'start' | 'stop' | 'restart';
export type ILogView = 'combined' | 'out' | 'err';
export type ILogChannel = 'out' | 'err' | 'shared';
export type IDaemonKind = 'local' | 'ssh';
export type IDaemonStatus = 'connecting' | 'online' | 'reconnecting' | 'offline' | 'error';

/** Colors a user can give a daemon, to tell production from development at a glance. */
export const DAEMON_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;
export type IDaemonColor = (typeof DAEMON_COLORS)[number];

/** A PM2 home directory on the computer that runs Captain. */
export interface ILocalDaemonConfig {
  daemonId: string;
  kind: 'local';
  /** Absolute path. */
  pm2Home: string;
  label?: string;
  color?: IDaemonColor;
}

/** A PM2 home on a server reached with the system SSH client. */
export interface ISshDaemonConfig {
  daemonId: string;
  kind: 'ssh';
  sshArgs: string[];
  /** Absolute or `~`-relative remote path. Omitted: the remote PM2_HOME, else ~/.pm2. */
  pm2Home?: string;
  label?: string;
  color?: IDaemonColor;
  lastKnownHostname?: string;
  lastKnownUsername?: string;
}

export type IDaemonConfig = ILocalDaemonConfig | ISshDaemonConfig;

/** A daemon as entered by the user or the command line, before it gets an ID. */
export type IDaemonInput =
  | Omit<ILocalDaemonConfig, 'daemonId'>
  | Omit<ISshDaemonConfig, 'daemonId' | 'lastKnownHostname' | 'lastKnownUsername'>;

export interface IDaemonSummary {
  daemonId: string;
  /**
   * Identifies the current connection to the daemon. It changes when the
   * daemon's location changes; lifecycle actions must send the one they saw.
   */
  connectionId: string;
  kind: IDaemonKind;
  label: string;
  color: IDaemonColor | null;
  hostname: string | null;
  username: string | null;
  status: IDaemonStatus;
  error: string | null;
  lastSeenAt: number | null;
}

/** A daemon together with its stored configuration, for the daemon settings screen. */
export interface IDaemonSettings extends IDaemonSummary {
  config: IDaemonConfig;
}

export interface IProcessSummary {
  daemonId: string;
  /** The daemon connection this process was read from. */
  connectionId: string;
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
  environment?: IEnvironmentVariable[];
}

export interface IEnvironmentVariable {
  name: string;
  value: string;
  isDivergent: boolean;
}

export interface IProcessListResult {
  daemons: IDaemonSummary[];
  processes: IProcessSummary[];
  /**
   * Set while the daemon registry on disk cannot be used. Captain keeps the
   * daemons it last loaded until the file is fixed.
   */
  registryWarning: string | null;
}

export interface ISingleDaemonProcessListResult {
  hostname: string;
  username: string;
  hostLabel: string;
  processes: IProcessSummary[];
}

export interface ILogEntry {
  id: string;
  daemonId: string;
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
