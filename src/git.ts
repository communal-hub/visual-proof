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

/**
 * Repo-relative POSIX paths changed on this branch: committed changes since `baseRef`
 * plus anything uncommitted (staged, unstaged, untracked-and-not-ignored).
 *
 * Committed side: `git diff base...HEAD` against `baseRef` (or `origin/<baseRef>` when
 * there is no local branch of that name, as in shallow cloud checkouts). When neither
 * resolves, fall back to `HEAD~1..HEAD` if HEAD has a parent, otherwise to uncommitted
 * changes only. A single-commit window is a guess, but it is the only commit we can
 * assume belongs to this task.
 */
export async function changedFiles(repoDir: string, baseRef: string): Promise<string[]> {
  const files = new Set<string>();

  for (const file of await committedChanges(repoDir, baseRef)) files.add(file);
  for (const file of await uncommittedChanges(repoDir)) files.add(file);

  return [...files].sort();
}

async function committedChanges(repoDir: string, baseRef: string): Promise<string[]> {
  for (const ref of [baseRef, `origin/${baseRef}`]) {
    if (!(await refExists(repoDir, ref))) continue;
    const diff = await git(repoDir, ['diff', '--name-only', '-z', `${ref}...HEAD`], {}, true);
    // Unrelated histories have no merge base; a plain two-dot diff is the closest meaning.
    if (diff.ok) return splitNul(diff.stdout);
    return splitNul((await git(repoDir, ['diff', '--name-only', '-z', ref, 'HEAD'], {}, true)).stdout);
  }
  if (await refExists(repoDir, 'HEAD~1')) {
    return splitNul((await git(repoDir, ['diff', '--name-only', '-z', 'HEAD~1', 'HEAD'])).stdout);
  }
  return [];
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
