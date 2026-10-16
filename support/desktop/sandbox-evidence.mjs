// Evidence that a running desktop app actually has Chromium's OS sandbox,
// rather than a sandbox: true preference. Used by the packaged smoke and
// update tests whenever they did not ask for --no-sandbox themselves.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The app's processes: the one that was started and all its descendants. */
export function listAppProcesses(rootPid) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='])
    .toString()
    .trim()
    .split('\n')
    .map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, args]) => ({ pid: Number(pid), ppid: Number(ppid), args }));
  const members = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (members.has(row.ppid) && !members.has(row.pid)) {
        members.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter(row => members.has(row.pid));
}

export const readProcessStatus = pid => {
  try {
    return readFileSync(`/proc/${pid}/status`, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Problems that show the app is not sandboxed. On Linux a sandboxed renderer
 * runs in its own PID namespace (two NSpid values) under a seccomp-bpf filter
 * (Seccomp: 2), with either the namespace or the setuid sandbox. Elsewhere the
 * command lines and the app's log are the evidence.
 */
export function assessSandbox({ processes, readStatus, platform, log }) {
  const problems = [];
  for (const process of processes) {
    if (process.args.split(/\s+/).includes('--no-sandbox')) {
      problems.push(`process ${process.pid} runs with --no-sandbox`);
    }
  }
  if (log.includes('Running without the Chromium sandbox')) {
    problems.push('the app logged that it runs without the sandbox');
  }
  if (platform === 'linux') {
    const renderers = processes.filter(process => process.args.includes('--type=renderer'));
    if (!renderers.length) {
      problems.push('no renderer process was found');
    }
    for (const renderer of renderers) {
      const status = readStatus(renderer.pid) ?? '';
      const namespacePids = /^NSpid:\s*(.*)$/m.exec(status)?.[1].trim().split(/\s+/) ?? [];
      if (namespacePids.length < 2) {
        problems.push(`renderer ${renderer.pid} is not in a sandbox PID namespace`);
      }
      if (!/^Seccomp:\s*2$/m.test(status)) {
        problems.push(`renderer ${renderer.pid} has no seccomp-bpf filter`);
      }
    }
  }
  return problems;
}
