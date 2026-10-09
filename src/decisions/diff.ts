import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Most characters of diff sent to the text model (it has a 32k-token window and is weak at long inputs). */
export const DIFF_LIMIT = 6000;

/** SHA-1 of the working-tree content of a repo-relative file, or null when it cannot be read (deleted). */
export function contentHash(repoDir: string, file: string): string | null {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(path.join(repoDir, file))).digest('hex');
  } catch {
    return null;
  }
}

/**
 * `git diff <base> -- <file>` trimmed to `limit` characters (kept from the start, with a marker). `base` is a
 * commit, a `a...b` range or `HEAD`. A file git has no diff for (new and untracked, or unchanged since `base`)
 * is sent as its own content instead, so the model still has something to read.
 */
export async function fileDiff(repoDir: string, base: string, files: string | string[], limit = DIFF_LIMIT): Promise<string> {
  const list = Array.isArray(files) ? files : [files];
  if (list.length === 0) return '';
  let diff = '';
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-color', '--no-ext-diff', '-U3', base, '--', ...list], {
      cwd: repoDir,
      maxBuffer: 16 * 1024 * 1024,
    });
    diff = stdout;
  } catch {
    // an unknown base or a path outside the repo: fall back to the content
  }
  if (diff.trim() === '') {
    diff = list
      .map((file) => {
        try {
          return `(no diff against ${base}; current content of ${file})\n${fs.readFileSync(path.join(repoDir, file), 'utf8')}`;
        } catch {
          return `(${file} cannot be read)`;
        }
      })
      .join('\n');
  }
  return trim(diff, limit);
}

export function trim(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n... (${text.length - limit} more characters trimmed)` : text;
}
