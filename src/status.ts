import fs from 'node:fs';
import { statusFiles, type Dirs } from './paths.js';

export type DaemonState = 'starting' | 'ready' | 'capturing' | 'error' | 'stopped';

/** What the watcher keeps in `status.json`. `finish` adds `lastFinish` to the same file. */
export interface Status {
  state: DaemonState;
  sessionId: string;
  /** Pid of the process running the watcher. */
  pid: number;
  startedAt: string;
  trigger: 'fs-watch';
  barrier: 'vite-hmr' | 'timeout-only';
  /** HEAD sha when the watcher started; `finish` diffs `anchor..HEAD` when the base ref gives nothing. */
  anchor: string | null;
  lastCaptureAt: string | null;
  /** When the trigger last saw a relevant file event (ISO). */
  lastEventAt: string | null;
  /** True from the first file event of a change until its batch (including re-queues) is fully handled. */
  pending: boolean;
  pendingSince: string | null;
  lastError: string | null;
  frames: number;
  /** Written by `finish`, not by the watcher; carried over on every status write so it is never lost. */
  lastFinish?: unknown;
}

/** Parsed `status.json`, or null when it is missing or torn. Fields are not trusted to be present. */
export function readStatusFile(file: string): Partial<Status> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Partial<Status>) : null;
  } catch {
    return null;
  }
}

/** Write `content` to `file` via a temporary sibling and a rename, so a reader never sees half a file. */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// ---- pid file ---------------------------------------------------------------

export function readPid(pidFile: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The live daemon's pid, removing a stale pid file as a side effect. */
export function livePid(pidFile: string): number | null {
  const pid = readPid(pidFile);
  if (pid === null) return null;
  if (isAlive(pid)) return pid;
  fs.rmSync(pidFile, { force: true });
  return null;
}

/**
 * The pid of a running watcher, from `status.json` (which also covers a watcher run in-process,
 * with no pid file) or the pid file; null when neither process exists. Has no side effects.
 */
export function watcherPid(dirs: Dirs, status: Partial<Status> | null = readStatusFile(statusFiles(dirs).status)): number | null {
  const candidates = [status?.pid, readPid(statusFiles(dirs).pid)];
  for (const pid of candidates) if (typeof pid === 'number' && pid > 0 && isAlive(pid)) return pid;
  return null;
}
