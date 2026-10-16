import { ChildProcess, ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import libOs from 'node:os';
import libPath from 'node:path';

import { IContainer } from '../container';
import { define } from '../framework/dependency_injection';
import { IAppLifecycleMethods } from './app';
import { trackOwnedProcess } from './owned_processes';

const SSH_CONNECT_TIMEOUT = 15_000;
/**
 * Bounds each connection attempt in SSH itself too, so an attempt outlives
 * Captain only briefly if Captain is killed before its own timer runs. An
 * option given first on the command line wins over the user's SSH config.
 */
const SSH_BASE_OPTIONS = ['-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT / 1000}`];
const MAX_SFTP_PACKET_SIZE = 16 * 1024 * 1024;
const REMOTE_INFO_MARKER = '__PM2_CAPTAIN_REMOTE__';
const REMOTE_INFO_COMMAND = `printf '${REMOTE_INFO_MARKER}\\n%s\\n%s\\n%s\\n%s\\n' "\${PM2_HOME:-$HOME/.pm2}" "\${USER:-$(id -un)}" "$(hostname)" "$HOME"`;

const enum SftpPacketType {
  Init = 1,
  Version = 2,
  Open = 3,
  Close = 4,
  Read = 5,
  Fstat = 8,
  Status = 101,
  Handle = 102,
  Data = 103,
  Attrs = 105,
}

const enum SftpStatusCode {
  Ok = 0,
  Eof = 1,
}

interface ISftpResponse {
  type: SftpPacketType;
  payload: Buffer;
}

interface IPendingSftpRequest {
  resolve: (response: ISftpResponse) => void;
  reject: (error: Error) => void;
}

/** Transport-neutral metadata needed by the reverse log reader. */
export interface IRandomAccessFileStat {
  identity: string;
  size: number;
}

/** A bounded random-access file handle backed by local fs or SFTP. */
export interface IRandomAccessFile {
  stat(): Promise<IRandomAccessFileStat>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** Non-sensitive identity and PM2 location discovered from a remote SSH host. */
export interface ISshRemoteInfo {
  pm2Home: string;
  username: string;
  hostname: string;
}

export class SshConnectionError extends Error {
  readonly code = 'SSH_CONNECTION_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'SshConnectionError';
  }
}

class BufferReader {
  _offset = 0;

  constructor(readonly _buffer: Buffer) {}

  uint32 = () => {
    if (this._offset + 4 > this._buffer.length) {
      throw new SshConnectionError('The SSH server returned a malformed SFTP packet.');
    }
    const value = this._buffer.readUInt32BE(this._offset);
    this._offset += 4;
    return value;
  };

  uint64 = () => {
    if (this._offset + 8 > this._buffer.length) {
      throw new SshConnectionError('The SSH server returned a malformed SFTP packet.');
    }
    const value = this._buffer.readBigUInt64BE(this._offset);
    this._offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SshConnectionError('The remote file is too large to read safely.');
    }
    return Number(value);
  };

  bytes = () => {
    const length = this.uint32();
    if (this._offset + length > this._buffer.length) {
      throw new SshConnectionError('The SSH server returned a malformed SFTP packet.');
    }
    const value = this._buffer.subarray(this._offset, this._offset + length);
    this._offset += length;
    return value;
  };

  string = () => this.bytes().toString('utf8');
}

function uint32(value: number) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function uint64(value: number) {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function sftpString(value: string | Buffer) {
  const data = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([uint32(data.length), data]);
}

class SftpClient {
  _buffer = Buffer.alloc(0);
  _nextRequestId = 1;
  _pending = new Map<number, IPendingSftpRequest>();
  _versionResolve: (() => void) | null = null;
  _versionReject: ((error: Error) => void) | null = null;

  constructor(readonly _process: ChildProcessWithoutNullStreams) {
    _process.stdout.on('data', (chunk: Buffer) => {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      try {
        this._processPackets();
      } catch (error) {
        const protocolError =
          error instanceof Error
            ? error
            : new SshConnectionError('The SSH server returned invalid SFTP data.');
        this.rejectAll(protocolError);
        _process.kill('SIGTERM');
      }
    });
  }

  initialize = () =>
    new Promise<void>((resolve, reject) => {
      this._versionResolve = resolve;
      this._versionReject = reject;
      this._writePacket(SftpPacketType.Init, uint32(3));
    });

  rejectAll = (error: Error) => {
    this._versionReject?.(error);
    this._versionResolve = null;
    this._versionReject = null;
    for (const request of this._pending.values()) {
      request.reject(error);
    }
    this._pending.clear();
  };

  open = async (path: string) => {
    const response = await this._request(SftpPacketType.Open, [
      sftpString(path),
      uint32(1),
      uint32(0),
    ]);
    if (response.type !== SftpPacketType.Handle) {
      throw new SshConnectionError('The SSH server returned an unexpected SFTP open response.');
    }
    return new SftpFile(this, path, new BufferReader(response.payload).bytes());
  };

  fstat = async (handle: Buffer) => {
    const response = await this._request(SftpPacketType.Fstat, [sftpString(handle)]);
    if (response.type !== SftpPacketType.Attrs) {
      throw new SshConnectionError('The SSH server returned an unexpected SFTP stat response.');
    }
    const reader = new BufferReader(response.payload);
    const flags = reader.uint32();
    if (!(flags & 1)) {
      throw new SshConnectionError('The SSH server did not report the remote file size.');
    }
    return { size: reader.uint64() };
  };

  read = async (handle: Buffer, position: number, length: number) => {
    const response = await this._request(
      SftpPacketType.Read,
      [sftpString(handle), uint64(position), uint32(length)],
      true
    );
    if (response.type === SftpPacketType.Status) {
      return Buffer.alloc(0);
    }
    if (response.type !== SftpPacketType.Data) {
      throw new SshConnectionError('The SSH server returned an unexpected SFTP read response.');
    }
    return new BufferReader(response.payload).bytes();
  };

  close = async (handle: Buffer) => {
    const response = await this._request(SftpPacketType.Close, [sftpString(handle)]);
    if (response.type !== SftpPacketType.Status) {
      throw new SshConnectionError('The SSH server returned an unexpected SFTP close response.');
    }
  };

  _request = (type: SftpPacketType, parts: Buffer[], allowEof = false): Promise<ISftpResponse> => {
    const requestId = this._nextRequestId++;
    const promise = new Promise<ISftpResponse>((resolve, reject) => {
      this._pending.set(requestId, { resolve, reject });
    });
    this._writePacket(type, Buffer.concat([uint32(requestId), ...parts]));
    return promise.then(response => {
      if (response.type !== SftpPacketType.Status) {
        return response;
      }
      const reader = new BufferReader(response.payload);
      const status = reader.uint32();
      const message = reader.string();
      if (status === SftpStatusCode.Ok || (allowEof && status === SftpStatusCode.Eof)) {
        return response;
      }
      throw new SshConnectionError(`SFTP request failed (${status}): ${message}`);
    });
  };

  _writePacket = (type: SftpPacketType, payload: Buffer) => {
    const body = Buffer.concat([Buffer.from([type]), payload]);
    this._process.stdin.write(Buffer.concat([uint32(body.length), body]));
  };

  _processPackets = () => {
    while (this._buffer.length >= 4) {
      const length = this._buffer.readUInt32BE(0);
      if (length < 1 || length > MAX_SFTP_PACKET_SIZE) {
        this.rejectAll(new SshConnectionError('The SSH server returned an invalid SFTP packet.'));
        return;
      }
      if (this._buffer.length < length + 4) {
        return;
      }
      const packet = this._buffer.subarray(4, length + 4);
      this._buffer = this._buffer.subarray(length + 4);
      const type = packet[0] as SftpPacketType;
      const payload = packet.subarray(1);
      if (type === SftpPacketType.Version) {
        const version = new BufferReader(payload).uint32();
        if (version !== 3) {
          this.rejectAll(new SshConnectionError(`Unsupported SFTP version: ${version}`));
        } else {
          this._versionResolve?.();
          this._versionResolve = null;
          this._versionReject = null;
        }
        continue;
      }
      const reader = new BufferReader(payload);
      const requestId = reader.uint32();
      const request = this._pending.get(requestId);
      if (!request) {
        continue;
      }
      this._pending.delete(requestId);
      request.resolve({ type, payload: payload.subarray(4) });
    }
  };
}

class SftpFile implements IRandomAccessFile {
  _identity: string | null = null;

  constructor(
    readonly _client: SftpClient,
    readonly _path: string,
    readonly _handle: Buffer
  ) {}

  stat = async () => {
    const { size } = await this._client.fstat(this._handle);
    if (!this._identity) {
      let fingerprint = 'small-file';
      if (size >= 256) {
        const prefix = await this._client.read(this._handle, 0, 256);
        fingerprint = createHash('sha256').update(prefix).digest('base64url');
      }
      this._identity = `sftp:${this._path}:${fingerprint}`;
    }
    return { identity: this._identity, size };
  };

  read = async (buffer: Buffer, offset: number, length: number, position: number) => {
    const data = await this._client.read(this._handle, position, length);
    data.copy(buffer, offset);
    return { bytesRead: data.length };
  };

  close = async () => {
    await this._client.close(this._handle);
  };
}

/**
 * Says what to do about an SSH failure. SSH reports its own errors with exit
 * code 255; a remote command never does that here.
 */
export function describeSshFailure(detail: string, exitCode: number | null) {
  if (exitCode !== 255) {
    return detail || `SSH exited ${exitCode}.`;
  }
  const hint = [
    'Captain runs your system ssh without a terminal, so it cannot ask for passwords, passphrases or new host keys.',
    'Check that "ssh <destination>" works without prompts: keys loaded in an SSH agent, and the host already in known_hosts.',
    process.env.SSH_AUTH_SOCK
      ? ''
      : 'No SSH agent is available to Captain (SSH_AUTH_SOCK is not set).',
  ]
    .filter(Boolean)
    .join(' ');
  return detail ? `${detail}\n${hint}` : `SSH could not connect. ${hint}`;
}

function describeSpawnError(error: NodeJS.ErrnoException) {
  return error.code === 'ENOENT'
    ? `The ssh command was not found. Install OpenSSH, or make sure ssh is on the PATH Captain runs with (${process.env.PATH || 'empty'}).`
    : `Unable to start SSH: ${error.message}`;
}

/**
 * Ends an SSH child. A detached child leads its own process group, which also
 * holds a ProxyCommand it started.
 */
function killSSH(child: ChildProcess, signal: NodeJS.Signals, isDetached: boolean) {
  if (isDetached && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is gone; fall back to the child itself.
    }
  }
  child.kill(signal);
}

async function runSSHCommand(
  sshArgs: string[],
  command: string,
  { isDetached, signal }: { isDetached: boolean; signal: AbortSignal }
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new SshConnectionError('The SSH connection is shutting down.'));
      return;
    }
    const child = spawn('ssh', [...SSH_BASE_OPTIONS, ...sshArgs, command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: isDetached,
    });
    trackOwnedProcess(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    let killTimer: NodeJS.Timeout | null = null;
    const end = (error: SshConnectionError) => {
      killSSH(child, 'SIGTERM', isDetached);
      killTimer = setTimeout(() => killSSH(child, 'SIGKILL', isDetached), 1_000);
      reject(error);
    };
    const timer = setTimeout(
      () => end(new SshConnectionError('SSH connection timed out.')),
      SSH_CONNECT_TIMEOUT
    );
    // Stopping Captain or removing the daemon ends a pending discovery at once.
    const onAbort = () => {
      clearTimeout(timer);
      end(new SshConnectionError('The SSH connection is shutting down.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize <= 64 * 1024) {
        stdout.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.concat(stderr).length < 64 * 1024) {
        stderr.push(chunk);
      }
    });
    child.once('error', error => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      reject(new SshConnectionError(describeSpawnError(error)));
    });
    child.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (killTimer) {
        clearTimeout(killTimer);
        // SSH ended on SIGTERM; a helper in its group may have ignored it.
        if (isDetached) {
          killSSH(child, 'SIGKILL', true);
        }
      }
      if (code === 0 && outputSize <= 64 * 1024) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      reject(
        new SshConnectionError(
          outputSize > 64 * 1024
            ? 'SSH returned too much output.'
            : describeSshFailure(detail, code)
        )
      );
    });
  });
}

/**
 * Reads the discovery output. A configured PM2 home replaces the discovered
 * one; a leading `~` in it stands for the remote user's home directory.
 */
export function parseRemoteInfo(
  output: string,
  configuredPm2Home: string | null = null
): ISshRemoteInfo {
  const lines = output.trim().split(/\r?\n/);
  const markerIndex = lines.lastIndexOf(REMOTE_INFO_MARKER);
  const [discoveredPm2Home, username, hostname, homeDirectory] = lines.slice(
    markerIndex + 1,
    markerIndex + 5
  );
  const pm2Home =
    configuredPm2Home === '~' || configuredPm2Home?.startsWith('~/')
      ? homeDirectory && libPath.posix.join(homeDirectory, configuredPm2Home.slice(1))
      : configuredPm2Home || discoveredPm2Home;
  // The path becomes part of an SSH stream-local forward ("local:remote").
  if (
    markerIndex < 0 ||
    !pm2Home ||
    !username ||
    !hostname ||
    pm2Home.includes('\0') ||
    pm2Home.includes(':')
  ) {
    throw new SshConnectionError('Unable to determine the remote PM2 home and host name.');
  }
  return { pm2Home, username, hostname };
}

export function createSshConnection({ settings, log }: IContainer) {
  // The desktop app has no terminal for SSH to prompt on. Its own process group
  // lets the app end SSH and its ProxyCommand together if this backend dies.
  // The CLI keeps SSH in its terminal's process group, as before.
  const isDetached = settings.runtime === 'desktop';
  let _discovery = new AbortController();
  let _remoteInfo: ISshRemoteInfo | null = null;
  let _socketDirectory: string | null = null;
  let _process: ChildProcessWithoutNullStreams | null = null;
  let _sftp: SftpClient | null = null;
  let _stderr = '';
  let _connectionPromise: Promise<void> | null = null;
  let _isStopping = false;

  const stopSSHProcess = async () => {
    const child = _process;
    _process = null;
    _sftp = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        killSSH(child, 'SIGKILL', isDetached);
        resolve();
      }, 1_000);
      child.once('close', () => {
        clearTimeout(timer);
        // SSH ended on SIGTERM; a helper in its group may have ignored it.
        if (isDetached) {
          killSSH(child, 'SIGKILL', true);
        }
        resolve();
      });
      child.stdin.end();
      killSSH(child, 'SIGTERM', isDetached);
    });
  };

  const releaseSSHResources = async () => {
    _isStopping = true;
    _discovery.abort();
    await stopSSHProcess();
    _sftp = null;
    _remoteInfo = null;
    if (_socketDirectory) {
      await fs.rm(_socketDirectory, { recursive: true, force: true });
      _socketDirectory = null;
    }
  };

  const connectSSH = async () => {
    if (!settings.sshArgs || !_remoteInfo || !_socketDirectory) {
      return;
    }
    if (_isStopping) {
      throw new SshConnectionError('The SSH connection is shutting down.');
    }
    if (_process && _process.exitCode === null && _process.signalCode === null && _sftp) {
      return;
    }
    if (_connectionPromise) {
      return _connectionPromise;
    }

    _connectionPromise = (async () => {
      const rpcSocket = libPath.join(_socketDirectory!, 'rpc.sock');
      const pubSocket = libPath.join(_socketDirectory!, 'pub.sock');
      const remoteRpcSocket = libPath.posix.join(_remoteInfo!.pm2Home, 'rpc.sock');
      const remotePubSocket = libPath.posix.join(_remoteInfo!.pm2Home, 'pub.sock');

      _stderr = '';
      const child = spawn(
        'ssh',
        [
          '-o',
          'ExitOnForwardFailure=yes',
          '-o',
          'StreamLocalBindUnlink=yes',
          '-L',
          `${rpcSocket}:${remoteRpcSocket}`,
          '-L',
          `${pubSocket}:${remotePubSocket}`,
          '-s',
          ...SSH_BASE_OPTIONS,
          ...settings.sshArgs!,
          'sftp',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], detached: isDetached }
      );
      trackOwnedProcess(child);
      _process = child;
      const sftp = new SftpClient(child);
      _sftp = sftp;
      child.stderr.on('data', (chunk: Buffer) => {
        if (_stderr.length < 64 * 1024) {
          _stderr += chunk.toString('utf8');
        }
      });

      const connectionFailure = new Promise<never>((_resolve, reject) => {
        child.once('error', error => {
          reject(new SshConnectionError(describeSpawnError(error)));
        });
        child.once('close', code => {
          const detail = _stderr.trim();
          const error = new SshConnectionError(
            code === 255
              ? describeSshFailure(detail, code)
              : detail || `SSH connection closed (${code}).`
          );
          sftp.rejectAll(error);
          if (_process === child) {
            _process = null;
            _sftp = null;
            if (!_isStopping) {
              log.warn({ code }, 'SSH connection closed');
            }
          }
          reject(error);
        });
      });
      let timeout: NodeJS.Timeout | null = null;
      const connectionTimeout = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new SshConnectionError('SSH SFTP connection timed out.')),
          SSH_CONNECT_TIMEOUT
        );
      });

      try {
        await Promise.race([sftp.initialize(), connectionFailure, connectionTimeout]);
      } catch (error) {
        if (_process === child) {
          await stopSSHProcess();
        }
        throw error;
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
      log.info(
        { hostname: _remoteInfo!.hostname, username: _remoteInfo!.username },
        'SSH connection established'
      );
    })().finally(() => {
      _connectionPromise = null;
    });
    return _connectionPromise;
  };

  return new (class SSHConnection implements IAppLifecycleMethods {
    get isRemote() {
      return settings.sshArgs !== null;
    }

    get socketDirectory() {
      return _socketDirectory;
    }

    get remoteInfo() {
      return _remoteInfo;
    }

    initialize = async () => {
      if (!settings.sshArgs) {
        return;
      }
      if (process.platform === 'win32') {
        throw new SshConnectionError('Remote PM2 connections require OpenSSH on macOS or Linux.');
      }
    };

    start = async () => {
      if (!settings.sshArgs) {
        return;
      }
      _isStopping = false;
      _discovery = new AbortController();
      try {
        _remoteInfo = parseRemoteInfo(
          await runSSHCommand(settings.sshArgs, REMOTE_INFO_COMMAND, {
            isDetached,
            signal: _discovery.signal,
          }),
          settings.pm2Home
        );
        _socketDirectory = await fs.mkdtemp(libPath.join(libOs.tmpdir(), 'pm2c-'));
        await connectSSH();
      } catch (error) {
        await releaseSSHResources();
        throw error;
      }
    };

    ensureConnected = connectSSH;

    /**
     * Ends a pending discovery or connection attempt and the SSH processes of
     * this daemon right away, without waiting for the attempt to finish first.
     */
    abort = releaseSSHResources;

    openFile = async (path: string): Promise<IRandomAccessFile> => {
      await connectSSH();
      if (!_sftp) {
        throw new SshConnectionError('The SFTP connection is not available.');
      }
      return _sftp.open(path);
    };

    stop = releaseSSHResources;

    dispose = releaseSSHResources;
  })();
}

export default define({
  createSshConnection,
});
