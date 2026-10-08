import { EXIT } from './exit.js';
import { pathsInfo, statusFiles, type Dirs } from './paths.js';
import { readLiveStatus, readPid } from './status.js';

export const DEFAULT_READY_TIMEOUT_S = 300;
const POLL_MS = 200;
/** How long a missing status file is tolerated while a `start` is still spawning the watcher (pid file present). */
const SPAWN_GRACE_MS = 5_000;

export interface WaitReadyOptions {
  dirs: Dirs;
  /** Seconds to wait. Default {@link DEFAULT_READY_TIMEOUT_S}. */
  timeoutSec?: number;
  out?: (text: string) => void;
  err?: (text: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** What `status --wait` concluded: ready, or a one-line reason why not (and whether waiting longer could help). */
export type ReadyVerdict = { ready: true } | { ready: false; reason: string; fatal: boolean };

/** Pure judgement of one status reading; `fatal` means no amount of waiting will make the watcher ready. */
export function judgeReady(status: Record<string, unknown>, hasPid: boolean): ReadyVerdict {
  const state = status.state;
  const lastError = typeof status.lastError === 'string' && status.lastError ? status.lastError : null;
  if (state === 'ready' && status.pending === false) return { ready: true };
  if (state === 'error') return { ready: false, fatal: true, reason: `watcher failed: ${lastError ?? 'unknown error'}` };
  if (state === 'stopped') {
    if (status.stale === true) return { ready: false, fatal: true, reason: `watcher is not running (${lastError ?? 'exited without stopping'})` };
    if (typeof status.sessionId === 'string') return { ready: false, fatal: true, reason: 'watcher was stopped' };
    return hasPid
      ? { ready: false, fatal: false, reason: 'watcher is starting (no status yet)' }
      : { ready: false, fatal: true, reason: 'no watcher is running (run visual-proof start)' };
  }
  if (state === 'ready') return { ready: false, fatal: false, reason: 'ready but a change is still pending' };
  if (state === 'capturing') return { ready: false, fatal: false, reason: 'capturing' };
  const warmup = status.warmup as { state?: string } | undefined;
  return { ready: false, fatal: false, reason: warmup?.state === 'running' ? 'starting (warming up Vite)' : `state ${String(state)}` };
}

/**
 * `visual-proof status --wait`: block until the watcher is `ready` with nothing pending. Exit 0 when it is,
 * 1 with a one-line reason on stderr when it fails fast (error, dead watcher, stopped) or the timeout passes.
 * stdout is always the final status JSON plus `paths`, as for plain `status`.
 */
export async function waitForReady(options: WaitReadyOptions): Promise<number> {
  const out = options.out ?? ((t) => process.stdout.write(t));
  const err = options.err ?? ((t) => process.stderr.write(t));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const files = statusFiles(options.dirs);
  const timeoutMs = (options.timeoutSec ?? DEFAULT_READY_TIMEOUT_S) * 1000;
  const started = now();

  for (;;) {
    const status = readLiveStatus(options.dirs);
    const spawning = readPid(files.pid) !== null && now() - started < SPAWN_GRACE_MS;
    const verdict = judgeReady(status, spawning);
    const timedOut = now() - started >= timeoutMs;
    if (verdict.ready || (!verdict.ready && (verdict.fatal || timedOut))) {
      out(`${JSON.stringify({ ...status, paths: pathsInfo(options.dirs) })}\n`);
      if (verdict.ready) return EXIT.OK;
      const reason = verdict.fatal ? verdict.reason : `not ready after ${options.timeoutSec ?? DEFAULT_READY_TIMEOUT_S} s: ${verdict.reason}`;
      err(`visual-proof status: not ready: ${reason} (status: ${files.status}, log: ${files.log})\n`);
      return 1;
    }
    await sleep(POLL_MS);
  }
}
