import fs from 'node:fs';
import { statusFiles, type Dirs } from './paths.js';

export type DaemonState = 'starting' | 'ready' | 'capturing' | 'error' | 'stopped';

export interface WarmupRouteStatus {
  /** Concrete path that was visited. */
  route: string;
  ms: number;
  ok: boolean;
  /** Vite reloads or dependency re-optimizations seen while loading it. */
  reloads?: number;
  error?: string;
}

/**
 * The pre-`ready` visit of a few routes that makes Vite compile and optimize before the first real capture.
 * `skipped`: nothing to visit or the capturer cannot prime; `timeout`: the budget ran out; `failed`: every
 * visit failed. None of these stop the watcher from becoming ready.
 */
export interface WarmupStatus {
  state: 'running' | 'done' | 'skipped' | 'failed' | 'timeout';
  /** Total warm-up time (absent while running). */
  ms?: number;
  routes: WarmupRouteStatus[];
}

/** What the last attempt to fill a route key from `paramSources` produced. */
export interface ParamSourceStatus {
  /** The concrete path it resolved to (kept after a later failure, which sets `error` too). */
  path?: string;
  /** Why the latest attempt failed; absent after a success. */
  error?: string;
  at: string;
}

/** What the latest link-discovery attempt for a route key produced (v0.8); `finish` quotes `error` when the route has no frame. */
export interface ParamDiscoveryStatus {
  /** The concrete path it resolved to (kept after a later failure, which sets `error` too). */
  path?: string;
  /** The page whose links gave the path. */
  foundOn?: string;
  /** Why the latest attempt failed, e.g. `no link matching /invoices/:id on /invoices`; absent after a success. */
  error?: string;
  at: string;
}

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
  /** Absent until the watcher reaches the warm-up step; `state` stays `starting` until it is finished. */
  warmup?: WarmupStatus;
  /** Per route key with a `paramSources` entry: the latest outcome. `finish` quotes the error when the route has no frame. */
  paramSources?: Record<string, ParamSourceStatus>;
  /** Per route key link discovery looked at this session: the latest outcome (v0.8). */
  paramDiscovery?: Record<string, ParamDiscoveryStatus>;
  /** Highest `session-params.json` revision the watcher has fully handled (v0.8); `params set` waits for it. */
  sessionParamsRev?: number;
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

/** A JSON file holding an object, or null when it is missing, torn or not an object. */
export function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
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

const RUNNING_STATES = ['starting', 'ready', 'capturing'];

/**
 * The status file as it should be read: a status that claims the watcher is running while its
 * process is gone (killed, crashed, rebooted) is reported as stopped and stale rather than trusted.
 */
export function readLiveStatus(dirs: Dirs): Record<string, unknown> {
  const stored = readStatusFile(statusFiles(dirs).status);
  if (stored === null) return { state: 'stopped' };
  if (RUNNING_STATES.includes(stored.state as string) && watcherPid(dirs, stored) === null) {
    return {
      ...stored,
      state: 'stopped',
      stale: true,
      pending: false,
      lastError: 'watcher exited without stopping',
    };
  }
  return { ...stored };
}

