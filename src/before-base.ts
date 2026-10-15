import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Scratch subdirectory holding the before frames (its own timeline, keyed by the merge-base tree). */
export const BEFORE_SCRATCH = 'before';

export interface MergeBase {
  commit: string;
  tree: string;
}

/**
 * The commit before frames are captured at: the merge-base of `baseRef` (or `origin/<baseRef>`) and HEAD, else the
 * watcher's anchor when it is an ancestor of HEAD. Null when there is neither (a repo without the base branch).
 */
export async function mergeBase(repoDir: string, baseRef: string, anchor?: unknown): Promise<MergeBase | null> {
  const candidates = [baseRef, `origin/${baseRef}`];
  for (const ref of candidates) {
    const commit = await gitLine(repoDir, ['merge-base', ref, 'HEAD']);
    if (commit) return withTree(repoDir, commit);
  }
  if (typeof anchor === 'string' && anchor !== '') {
    const ok = await gitLine(repoDir, ['merge-base', '--is-ancestor', anchor, 'HEAD'], true);
    if (ok !== null) return withTree(repoDir, anchor);
  }
  return null;
}

async function withTree(repoDir: string, commit: string): Promise<MergeBase | null> {
  const tree = await gitLine(repoDir, ['rev-parse', `${commit}^{tree}`]);
  return tree ? { commit, tree } : null;
}

/** First line of a git command's output; `allowEmpty` turns an exit-0 empty answer into ''. Null on failure. */
async function gitLine(repoDir: string, args: string[], allowEmpty = false): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd: repoDir, maxBuffer: 1024 * 1024 });
    const line = stdout.split('\n')[0]!.trim();
    return line !== '' ? line : allowEmpty ? '' : null;
  } catch {
    return null;
  }
}
