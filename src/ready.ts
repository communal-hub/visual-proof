import { outstanding, requestClaimCapture, type ClaimStatus } from './claim-status.js';
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
  /** v0.13 `--claim`: wait for the claim screens only, not for impact routes or later batches. */
  claim?: boolean;
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
 * `ready --claim`: whether every screen the claim names has a clean frame that stands at the tree the watcher last
 * hashed, once the watcher has answered claim request `rev` (so a save made just before is accounted for). Impact
 * routes and later batches do not matter. A claim screen whose frame is not clean, whose params nothing fills, or that
 * the watcher could not capture is fatal: waiting will not change it.
 */
export function judgeClaimReady(status: Record<string, unknown>, hasPid: boolean, rev: number): ReadyVerdict {
  const base = judgeReady(status, hasPid);
  if (!base.ready && base.fatal) return base;
  if (status.state === 'starting' || status.state === 'stopped') return base.ready ? { ready: false, fatal: false, reason: 'starting' } : base;
  const claim = status.claim as ClaimStatus | undefined;
  if (!claim) {
    return typeof status.repoDir === 'string'
      ? { ready: false, fatal: false, reason: 'the watcher has not checked the claim screens yet' }
      : { ready: false, fatal: true, reason: 'this watcher does not report claim readiness (it is older than visual-proof 0.13): restart it with visual-proof stop && visual-proof start' };
  }
  if ((claim.request ?? 0) < rev) return { ready: false, fatal: false, reason: 'the watcher has not picked up the claim request yet' };
  if (claim.error) return { ready: false, fatal: true, reason: `the claim screens cannot be captured: ${claim.error}` };
  if (!claim.current) return { ready: false, fatal: false, reason: 'files changed since the claim screens were checked' };
  if (claim.total === 0) {
    return { ready: false, fatal: true, reason: `the claim names no screens: write \`<screen>: <what must be visible>\` lines (a route like /invoices/:id, or sidecar <name> / <still>) to ${claim.file}` };
  }
  if (claim.ready) return { ready: true };
  const idle = status.state === 'ready' && status.pending === false;
  const blocked = claim.screens.filter((s) => s.state === 'not-clean' || s.state === 'unfilled' || (s.state === 'missing' && idle));
  if (blocked.length > 0) {
    const what = blocked.map((s) => {
      const where = s.target && s.target !== s.screen ? ` (${s.target})` : '';
      if (s.state === 'unfilled') return `${s.screen}: route params unfilled${s.reason ? ` (${s.reason})` : ''}; set them with visual-proof params set`;
      if (s.state === 'missing') return `${s.screen}${where}: no frame${s.reason ? ` (${s.reason})` : ''}; see the watcher log`;
      return `${s.screen}${where}: frame ${s.frameId ?? ''} is not clean${s.reason ? `: ${s.reason}` : ''}`;
    });
    return { ready: false, fatal: true, reason: `claim screen ${what.join('; ')}` };
  }
  return { ready: false, fatal: false, reason: `claim: ${claim.captured}/${claim.total} captured` };
}

/**
 * `visual-proof status --wait`: block until the watcher is `ready` with nothing pending (with `claim`, until the claim
 * screens are ready; see {@link judgeClaimReady}). Exit 0 when it is, 1 with a one-line reason on stderr when it fails
 * fast (error, dead watcher, stopped) or the timeout passes; the timeout reason says what is still outstanding.
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
  // v0.13: ask the watcher to look at the claim screens now, ahead of any impact routes it is capturing.
  const rev = options.claim ? requestClaimCapture(files.claimRequest, 'ready --claim', now()) : 0;

  for (;;) {
    const status = readLiveStatus(options.dirs);
    const spawning = readPid(files.pid) !== null && now() - started < SPAWN_GRACE_MS;
    const verdict = options.claim ? judgeClaimReady(status, spawning, rev) : judgeReady(status, spawning);
    const timedOut = now() - started >= timeoutMs;
    if (verdict.ready || (!verdict.ready && (verdict.fatal || timedOut))) {
      out(`${JSON.stringify({ ...status, paths: pathsInfo(options.dirs) })}\n`);
      if (verdict.ready) return EXIT.OK;
      // What is still outstanding, e.g. "claim: 1/2 captured; impact: 31 queued".
      const left = outstanding(status);
      const detail = verdict.reason.startsWith('claim:') && left ? left : [verdict.reason, left].filter(Boolean).join('; ');
      const reason = verdict.fatal ? verdict.reason : `not ready after ${options.timeoutSec ?? DEFAULT_READY_TIMEOUT_S} s: ${detail}`;
      err(`visual-proof status: not ready: ${reason} (status: ${files.status}, log: ${files.log})\n`);
      return 1;
    }
    await sleep(POLL_MS);
  }
}
