import { readJsonObject, writeFileAtomic } from './status.js';

/**
 * Claim readiness (v0.13): whether every screen the claim names has a clean frame at the working tree the watcher
 * last hashed. The watcher keeps it in `status.json` as `claim`; `ready --claim` waits on it and `finish` reads it to
 * say what it is still waiting for.
 */

/**
 * Where one claim screen stands:
 *  - `clean`: a clean frame at the current tree;
 *  - `carried`: a clean frame at an earlier tree that nothing changed since can reach (the rules `finish` carries with);
 *  - `not-clean`: the frame at the current tree shows an error, a spinner, a login page...;
 *  - `queued`: in the batch being captured, or in the next one;
 *  - `missing`: no usable frame and nothing queued for it;
 *  - `unfilled`: a route key whose params no tier fills;
 *  - `unmatched`: a claim line that names neither a route (`/...`) nor a sidecar still; it is not waited on.
 */
export type ClaimScreenState = 'clean' | 'carried' | 'not-clean' | 'queued' | 'missing' | 'unfilled' | 'unmatched';

export interface ClaimScreenStatus {
  /** The screen as the claim names it. */
  screen: string;
  kind: 'route' | 'sidecar' | 'unmatched';
  /** The concrete path, or the sidecar file. */
  target?: string;
  state: ClaimScreenState;
  frameId?: string;
  /** Tree of the frame, when it was carried from an earlier one. */
  frameTree?: string;
  reason?: string;
}

export interface ClaimStatus {
  /** The claim file read. */
  file: string;
  /** The working-tree hash the states are for; null before the first one. */
  tree: string | null;
  /** False from the first file event after `tree` was hashed until the watcher has looked again. */
  current: boolean;
  /** Every route and sidecar screen the claim names is `clean` or `carried` (false when it names none). */
  ready: boolean;
  /** Screens that are waited on (all but `unmatched`), and how many of them are ready. */
  total: number;
  captured: number;
  screens: ClaimScreenStatus[];
  /** Highest claim request (`claim-request.json` rev) the watcher has handled. */
  request: number;
  /** Why the claim screens cannot be captured at all (a stale freshness marker). */
  error?: string;
}

/** Work left in the batch being captured, by tier (v0.13). */
export interface RemainingWork {
  claim: number;
  headline: number;
  impact: number;
}

const READY_STATES: ReadonlySet<ClaimScreenState> = new Set(['clean', 'carried']);

export function screenReady(state: ClaimScreenState): boolean {
  return READY_STATES.has(state);
}

/** `claim: 1/2 captured; impact: 31 queued` from a status object; empty when there is nothing to say. */
export function outstanding(status: Record<string, unknown> | null | undefined): string {
  if (!status) return '';
  const parts: string[] = [];
  const claim = status.claim as Partial<ClaimStatus> | undefined;
  if (claim && typeof claim.total === 'number' && claim.total > 0) {
    const waiting = (claim.screens ?? []).filter((s) => s.kind !== 'unmatched' && !screenReady(s.state)).map((s) => `${s.screen} ${s.state}`);
    parts.push(`claim: ${claim.captured ?? 0}/${claim.total} captured${waiting.length > 0 ? ` (${waiting.slice(0, 3).join(', ')}${waiting.length > 3 ? ', ...' : ''})` : ''}`);
  }
  const remaining = status.remaining as Partial<RemainingWork> | undefined;
  if (remaining) {
    if ((remaining.claim ?? 0) > 0) parts.push(`claim screens: ${remaining.claim} queued`);
    if ((remaining.headline ?? 0) > 0) parts.push(`headlines: ${remaining.headline} queued`);
    if ((remaining.impact ?? 0) > 0) parts.push(`impact: ${remaining.impact} queued`);
  }
  return parts.join('; ');
}

// ---- claim requests -----------------------------------------------------------------

/**
 * `claim-request.json` in the status dir asks a running watcher to capture the claim screens now, ahead of any impact
 * routes it is busy with: `ready --claim` and `finish` write it, the watcher acknowledges the rev in `claim.request`.
 */
export interface ClaimRequest {
  rev: number;
  from: string;
  at: string;
}

export function readClaimRequest(file: string): ClaimRequest | null {
  const raw = readJsonObject(file);
  if (!raw || typeof raw.rev !== 'number' || !Number.isFinite(raw.rev)) return null;
  return { rev: raw.rev, from: typeof raw.from === 'string' ? raw.from : 'unknown', at: typeof raw.at === 'string' ? raw.at : '' };
}

/** Write a new request and return its rev (always above the previous one), or 0 when it cannot be written. */
export function requestClaimCapture(file: string, from: string, now = Date.now()): number {
  const previous = readClaimRequest(file)?.rev ?? 0;
  const rev = Math.max(previous + 1, now);
  try {
    writeFileAtomic(file, `${JSON.stringify({ rev, from, at: new Date(now).toISOString() } satisfies ClaimRequest)}\n`);
  } catch {
    return 0; // no status dir (no watcher to ask) or not writable: asking is a convenience, never a failure
  }
  return rev;
}
