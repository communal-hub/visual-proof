import fs from 'node:fs';
import path from 'node:path';
import { currentBranch, headCommit, isAncestorOfHead, repoToplevel } from './git.js';
import { readJsonObject, writeFileAtomic } from './status.js';

/** A stored anchor older than this is replaced by HEAD: a leftover from an earlier task must not widen today's diff. */
export const ANCHOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const ANCHOR_FILE = 'anchors.json';

interface AnchorEntry {
  anchor: string;
  /** ISO time the anchor was first recorded. */
  at: string;
}

export interface AnchorResult {
  /** The commit `finish` diffs from; null outside a repo or with no commits. */
  anchor: string | null;
  /** `new`: HEAD was recorded; `reused`: the earliest anchor of this branch survived a restart; `unpersisted`: no repo or branch to key on. */
  source: 'new' | 'reused' | 'unpersisted';
  /** Why a stored anchor was not reused, when one existed. */
  discarded?: string;
}

export interface AnchorOptions {
  repoDir: string;
  statusDir: string;
  now?: () => number;
  /** Injected HEAD lookup (the watcher's own `headCommit` option). */
  headCommit?: (repoDir: string) => Promise<string | null>;
}

/**
 * The diff anchor for this daemon session. `finish` diffs `anchor..HEAD` when the base ref gives nothing, so
 * it must be the commit the *task* started from, not the commit a restarted daemon happens to see. The
 * earliest anchor is therefore kept in `<statusDir>/anchors.json`, keyed by git toplevel + branch, and
 * reused while it is still an ancestor of HEAD and younger than {@link ANCHOR_MAX_AGE_MS}. A reset,
 * rebase or recreated branch no longer contains it and starts over from HEAD. Never throws.
 */
export async function resolveAnchor(options: AnchorOptions): Promise<AnchorResult> {
  const head = await (options.headCommit ?? headCommit)(options.repoDir).catch(() => null);
  if (!head) return { anchor: null, source: 'unpersisted' };

  const [toplevel, branch] = await Promise.all([
    repoToplevel(options.repoDir).catch(() => null),
    currentBranch(options.repoDir).catch(() => null),
  ]);
  if (!toplevel || !branch) return { anchor: head, source: 'unpersisted' };

  const key = anchorKey(toplevel, branch);
  const file = path.join(options.statusDir, ANCHOR_FILE);
  const now = (options.now ?? Date.now)();
  const entries = readEntries(file);

  let discarded: string | undefined;
  const stored = entries[key];
  if (stored) {
    const age = now - Date.parse(stored.at);
    if (!Number.isFinite(age) || age > ANCHOR_MAX_AGE_MS) {
      discarded = `stored anchor ${stored.anchor.slice(0, 8)} is older than ${ANCHOR_MAX_AGE_MS / 3_600_000} h`;
    } else if (!(await isAncestorOfHead(options.repoDir, stored.anchor).catch(() => false))) {
      discarded = `stored anchor ${stored.anchor.slice(0, 8)} is not an ancestor of HEAD (history was rewritten or the branch recreated)`;
    } else {
      return { anchor: stored.anchor, source: 'reused' };
    }
  }

  entries[key] = { anchor: head, at: new Date(now).toISOString() };
  try {
    fs.mkdirSync(options.statusDir, { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(entries, null, 2)}\n`);
  } catch {
    // The status dir is unwritable: the anchor still works for this session.
  }
  return { anchor: head, source: 'new', ...(discarded ? { discarded } : {}) };
}

export function anchorKey(toplevel: string, branch: string): string {
  return `${toplevel}\n${branch}`;
}

function readEntries(file: string): Record<string, AnchorEntry> {
  const raw = readJsonObject(file) ?? {};
  const entries: Record<string, AnchorEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) continue;
    const { anchor, at } = value as Partial<AnchorEntry>;
    if (typeof anchor === 'string' && typeof at === 'string') entries[key] = { anchor, at };
  }
  return entries;
}
