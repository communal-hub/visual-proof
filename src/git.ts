import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface GitResult {
  stdout: string;
  ok: boolean;
}

/** Run git without a shell. With `allowFail`, a non-zero exit yields `ok: false` instead of throwing. */
async function git(
  repoDir: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  allowFail = false,
): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoDir,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, ok: true };
  } catch (err) {
    if (allowFail && typeof (err as { code?: unknown }).code === 'number') {
      return { stdout: '', ok: false };
    }
    throw err;
  }
}

/**
 * Hash of the working tree (tracked + untracked, minus ignored files), computed in a
 * throwaway index so the real index is never modified.
 */
export async function workingTreeHash(repoDir: string, scratchDir: string): Promise<string> {
  const { stdout } = await git(repoDir, ['rev-parse', '--git-path', 'index']);
  const realIndex = path.resolve(repoDir, stdout.trim());

  fs.mkdirSync(scratchDir, { recursive: true });
  const tempIndex = path.join(scratchDir, `index.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    if (fs.existsSync(realIndex)) {
      fs.copyFileSync(realIndex, tempIndex);
      // Git decides whether an entry's stat data can be trusted by comparing it with the index
      // file's own mtime ("racily clean" entries are re-hashed). A fresh copy would have mtime
      // "now", making a same-size edit made in the same second as the last index write look
      // unchanged, so keep the real index's timestamps.
      const { atime, mtime } = fs.statSync(realIndex);
      fs.utimesSync(tempIndex, atime, mtime);
    }
    const env = { GIT_INDEX_FILE: tempIndex };
    await git(repoDir, ['add', '-A'], env);
    return (await git(repoDir, ['write-tree'], env)).stdout.trim();
  } finally {
    fs.rmSync(tempIndex, { force: true });
  }
}

/** Whether `repoDir` is inside a git work tree. */
export async function isGitRepo(repoDir: string): Promise<boolean> {
  const { stdout, ok } = await git(repoDir, ['rev-parse', '--is-inside-work-tree'], {}, true);
  return ok && stdout.trim() === 'true';
}

/** `HEAD^{tree}`, or null when the repo has no commits yet. */
export async function headTree(repoDir: string): Promise<string | null> {
  const { stdout, ok } = await git(repoDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], {}, true);
  return ok ? stdout.trim() : null;
}

/** What changed on this branch and how it was found. */
export interface ChangeSet {
  /** Paths relative to `repoDir` (POSIX), sorted. */
  files: string[];
  /**
   * The committed range that was diffed, e.g. `main...HEAD`, `a1b2c3d..HEAD` or `HEAD~1..HEAD`;
   * null when only uncommitted changes could be considered.
   */
  range: string | null;
}

export interface ChangeOptions {
  /** HEAD sha the watcher started from; the fallback range when the base ref gives nothing. */
  anchor?: string | null;
}

/** HEAD's commit sha, or null when the repo has no commits. */
export async function headCommit(repoDir: string): Promise<string | null> {
  const { stdout, ok } = await git(repoDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {}, true);
  return ok ? stdout.trim() : null;
}

/** Absolute path of the git toplevel containing `repoDir`, or null outside a repo. */
export async function repoToplevel(repoDir: string): Promise<string | null> {
  const { stdout, ok } = await git(repoDir, ['rev-parse', '--show-toplevel'], {}, true);
  return ok && stdout.trim() ? stdout.trim() : null;
}

/** Current branch name, `(detached)` on a detached HEAD, or null outside a repo / without commits. */
export async function currentBranch(repoDir: string): Promise<string | null> {
  const named = await git(repoDir, ['symbolic-ref', '--short', '--quiet', 'HEAD'], {}, true);
  if (named.ok && named.stdout.trim()) return named.stdout.trim();
  return (await headCommit(repoDir)) ? '(detached)' : null;
}

/** Whether `ancestor` is HEAD or one of its ancestors (false when it does not resolve). */
export async function isAncestorOfHead(repoDir: string, ancestor: string): Promise<boolean> {
  if (!(await refExists(repoDir, ancestor))) return false;
  return (await git(repoDir, ['merge-base', '--is-ancestor', ancestor, 'HEAD'], {}, true)).ok;
}

/**
 * Repo-relative POSIX paths changed on this branch: committed changes plus anything uncommitted
 * (staged, unstaged, untracked-and-not-ignored).
 *
 * Committed side, first that applies:
 *  1. `git diff base...HEAD` against `baseRef` (or `origin/<baseRef>` when there is no local branch of
 *     that name, as in shallow cloud checkouts), when it is not empty.
 *  2. `anchor..HEAD`, when the watcher recorded the commit it started from.
 *  3. `HEAD~1..HEAD`, when HEAD has a parent.
 *  4. Nothing: uncommitted changes only.
 *
 * An empty `base...HEAD` is not trusted (working directly on the base branch makes it empty even
 * though commits were made), hence 2 and 3. A single-commit window is a guess, but it is the only
 * commit we can assume belongs to this task.
 */
export async function changeSet(repoDir: string, baseRef: string, options: ChangeOptions = {}): Promise<ChangeSet> {
  const prefix = await showPrefix(repoDir);
  const files = new Set<string>();

  const committed = await committedChanges(repoDir, baseRef, options.anchor ?? null);
  for (const file of committed.files) files.add(file);
  for (const file of await uncommittedChanges(repoDir)) files.add(file);

  return { files: [...files].flatMap((file) => relativeTo(prefix, file)).sort(), range: committed.range };
}

/** {@link changeSet} without the range. */
export async function changedFiles(repoDir: string, baseRef: string, options: ChangeOptions = {}): Promise<string[]> {
  return (await changeSet(repoDir, baseRef, options)).files;
}

/**
 * `git rev-parse --show-prefix`: the path of `repoDir` below the git toplevel (`sub/dir/`), or ''
 * at the toplevel. `git diff --name-only` and `git status --porcelain` report toplevel-relative
 * paths, while config globs are relative to the config directory.
 */
export async function showPrefix(repoDir: string): Promise<string> {
  return (await git(repoDir, ['rev-parse', '--show-prefix'])).stdout.trim();
}

/** The path below `prefix` (a toplevel-relative directory ending in `/`), or nothing when it lies outside it. */
function relativeTo(prefix: string, file: string): string[] {
  if (prefix === '') return [file];
  return file.startsWith(prefix) ? [file.slice(prefix.length)] : [];
}

async function committedChanges(
  repoDir: string,
  baseRef: string,
  anchor: string | null,
): Promise<{ files: string[]; range: string | null }> {
  for (const ref of [baseRef, `origin/${baseRef}`]) {
    if (!(await refExists(repoDir, ref))) continue;
    const diff = await git(repoDir, ['diff', '--name-only', '-z', `${ref}...HEAD`], {}, true);
    if (diff.ok) {
      const files = splitNul(diff.stdout);
      if (files.length > 0) return { files, range: `${ref}...HEAD` };
    } else {
      // Unrelated histories have no merge base; a plain two-dot diff is the closest meaning.
      const files = splitNul((await git(repoDir, ['diff', '--name-only', '-z', ref, 'HEAD'], {}, true)).stdout);
      if (files.length > 0) return { files, range: `${ref}..HEAD` };
    }
    break; // the base resolved but gave nothing: do not trust the emptiness, look at the anchor / parent
  }
  if (anchor && (await refExists(repoDir, anchor))) {
    const files = splitNul((await git(repoDir, ['diff', '--name-only', '-z', anchor, 'HEAD'])).stdout);
    return { files, range: `${anchor.slice(0, 8)}..HEAD` };
  }
  if (await refExists(repoDir, 'HEAD~1')) {
    return { files: splitNul((await git(repoDir, ['diff', '--name-only', '-z', 'HEAD~1', 'HEAD'])).stdout), range: 'HEAD~1..HEAD' };
  }
  return { files: [], range: null };
}

async function uncommittedChanges(repoDir: string): Promise<string[]> {
  const { stdout } = await git(repoDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = splitNul(stdout);
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    files.push(entry.slice(3));
    // Renames and copies are followed by the original path as a separate entry.
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
      files.push(entries[++i]!);
    }
  }
  return files;
}

async function refExists(repoDir: string, ref: string): Promise<boolean> {
  return (await git(repoDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {}, true)).ok;
}

function splitNul(output: string): string[] {
  return output.split('\0').filter(Boolean);
}
