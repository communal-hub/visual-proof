import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { changedFiles, changeSet, headCommit, headTree, workingTreeHash } from '../../src/git.js';
import { commitAll, git, initRepo, tmpDir, write } from './helpers.js';

let repo: string;
let scratch: string;

beforeEach(() => {
  repo = initRepo();
  scratch = tmpDir('vp-scratch-');
  write(repo, 'a.txt', 'one\n');
  write(repo, 'src/b.vue', '<template/>\n');
  write(repo, '.gitignore', 'ignored/\n*.log\n');
  commitAll(repo, 'initial');
});

describe('workingTreeHash', () => {
  it('equals HEAD^{tree} on a clean tree', async () => {
    expect(await workingTreeHash(repo, scratch)).toBe(git(repo, 'rev-parse', 'HEAD^{tree}'));
    expect(await headTree(repo)).toBe(git(repo, 'rev-parse', 'HEAD^{tree}'));
  });

  it('changes on an unstaged edit and returns after revert', async () => {
    const clean = await workingTreeHash(repo, scratch);
    write(repo, 'a.txt', 'two\n');
    const dirty = await workingTreeHash(repo, scratch);
    expect(dirty).not.toBe(clean);
    write(repo, 'a.txt', 'one\n');
    expect(await workingTreeHash(repo, scratch)).toBe(clean);
  });

  it('sees a same-size edit made in the same second as the last index write', async () => {
    // Reproduce git's "racily clean" window deterministically: the file and the index share an
    // mtime, and the edit keeps the size. A copy of the index with a fresh mtime would hide it.
    git(repo, 'config', 'core.trustctime', 'false');
    const second = new Date(Date.now() - 100_000);
    const file = path.join(repo, 'a.txt');
    fs.utimesSync(file, second, second);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'restamp');
    git(repo, 'update-index', '--refresh');
    fs.utimesSync(path.join(repo, '.git', 'index'), second, second);

    const clean = await workingTreeHash(repo, scratch);
    write(repo, 'a.txt', 'two\n');
    fs.utimesSync(file, second, second);
    expect(await workingTreeHash(repo, scratch)).not.toBe(clean);
  });

  it('equals the new HEAD^{tree} after committing the edit', async () => {
    write(repo, 'a.txt', 'two\n');
    write(repo, 'new.txt', 'new\n');
    const dirty = await workingTreeHash(repo, scratch);
    commitAll(repo, 'edit');
    expect(await headTree(repo)).toBe(dirty);
  });

  it('includes untracked files and deletions', async () => {
    const clean = await workingTreeHash(repo, scratch);
    write(repo, 'untracked.txt', 'x');
    const withUntracked = await workingTreeHash(repo, scratch);
    expect(withUntracked).not.toBe(clean);
    fs.rmSync(path.join(repo, 'untracked.txt'));
    fs.rmSync(path.join(repo, 'a.txt'));
    expect(await workingTreeHash(repo, scratch)).not.toBe(clean);
  });

  it('ignores .gitignored files', async () => {
    const clean = await workingTreeHash(repo, scratch);
    write(repo, 'ignored/x.txt', 'x');
    write(repo, 'debug.log', 'x');
    expect(await workingTreeHash(repo, scratch)).toBe(clean);
  });

  it('leaves the real index byte-for-byte untouched and removes its temp index', async () => {
    write(repo, 'staged.txt', 's');
    git(repo, 'add', 'staged.txt');
    write(repo, 'a.txt', 'unstaged edit\n');
    write(repo, 'untracked.txt', 'u');

    const indexPath = path.join(repo, '.git', 'index');
    const before = fs.readFileSync(indexPath);
    const statusBefore = git(repo, 'status', '--porcelain');

    await workingTreeHash(repo, scratch);

    expect(fs.readFileSync(indexPath).equals(before)).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it('works in a repo with no commits and no index yet', async () => {
    const fresh = initRepo();
    write(fresh, 'x.txt', 'x');
    const hash = await workingTreeHash(fresh, scratch);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(fresh, '.git', 'index'))).toBe(false);
  });

  it('creates the scratch dir if missing', async () => {
    const nested = path.join(scratch, 'a', 'b');
    await workingTreeHash(repo, nested);
    expect(fs.statSync(nested).isDirectory()).toBe(true);
  });

  it('rejects when repoDir is not a git repo', async () => {
    await expect(workingTreeHash(tmpDir(), scratch)).rejects.toThrow();
  });
});

describe('headTree', () => {
  it('is null when the repo has no commits', async () => {
    expect(await headTree(initRepo())).toBeNull();
  });
});

describe('changedFiles', () => {
  it('unions branch commits with staged, unstaged and untracked changes, minus ignored', async () => {
    git(repo, 'checkout', '-q', '-b', 'feature');
    write(repo, 'committed.txt', 'c');
    commitAll(repo, 'on branch');

    write(repo, 'staged.txt', 's');
    git(repo, 'add', 'staged.txt');
    write(repo, 'a.txt', 'edited\n');
    write(repo, 'untracked.txt', 'u');
    write(repo, 'ignored/x.txt', 'x');
    write(repo, 'debug.log', 'x');

    expect(await changedFiles(repo, 'main')).toEqual([
      'a.txt',
      'committed.txt',
      'staged.txt',
      'untracked.txt',
    ]);
  });

  it('reports files in untracked directories individually', async () => {
    write(repo, 'newdir/deep/x.vue', 'x');
    expect(await changedFiles(repo, 'main')).toEqual(['newdir/deep/x.vue']);
  });

  it('includes deletions and both sides of a rename', async () => {
    git(repo, 'checkout', '-q', '-b', 'feature');
    git(repo, 'mv', 'a.txt', 'renamed.txt');
    fs.rmSync(path.join(repo, 'src', 'b.vue'));
    expect(await changedFiles(repo, 'main')).toEqual(['a.txt', 'renamed.txt', 'src/b.vue']);
  });

  it('is empty on a clean tree at the base ref', async () => {
    expect(await changedFiles(repo, 'main')).toEqual([]);
  });

  it('uses merge-base semantics (three-dot) so base-only commits are excluded', async () => {
    git(repo, 'checkout', '-q', '-b', 'feature');
    write(repo, 'feature.txt', 'f');
    commitAll(repo, 'feature work');
    git(repo, 'checkout', '-q', 'main');
    write(repo, 'main-only.txt', 'm');
    commitAll(repo, 'main moved');
    git(repo, 'checkout', '-q', 'feature');
    expect(await changedFiles(repo, 'main')).toEqual(['feature.txt']);
  });

  it('falls back to HEAD~1..HEAD when the base ref does not exist', async () => {
    write(repo, 'second.txt', 's');
    commitAll(repo, 'second');
    write(repo, 'dirty.txt', 'd');
    expect(await changedFiles(repo, 'no-such-branch')).toEqual(['dirty.txt', 'second.txt']);
  });

  describe('working directly on the base branch (base...HEAD is empty)', () => {
    it('does not report an empty set for a commit made on the base branch: HEAD~1..HEAD without an anchor', async () => {
      write(repo, 'src/b.vue', '<template>edited</template>\n');
      commitAll(repo, 'commit on main');
      expect(await changeSet(repo, 'main')).toEqual({ files: ['src/b.vue'], range: 'HEAD~1..HEAD' });
    });

    it('prefers the watcher anchor: every commit since the daemon started, not just the last', async () => {
      const anchor = (await headCommit(repo))!;
      write(repo, 'src/one.vue', '1');
      commitAll(repo, 'one');
      write(repo, 'src/two.vue', '2');
      commitAll(repo, 'two');
      expect(await changeSet(repo, 'main', { anchor })).toEqual({
        files: ['src/one.vue', 'src/two.vue'],
        range: `${anchor.slice(0, 8)}..HEAD`,
      });
    });

    it('an anchor equal to HEAD means nothing was committed since the daemon started', async () => {
      write(repo, 'src/old.vue', 'old');
      commitAll(repo, 'before the daemon');
      const anchor = (await headCommit(repo))!;
      write(repo, 'dirty.txt', 'd');
      expect(await changeSet(repo, 'main', { anchor })).toEqual({ files: ['dirty.txt'], range: `${anchor.slice(0, 8)}..HEAD` });
    });

    it('ignores an anchor that no longer resolves', async () => {
      write(repo, 'src/one.vue', '1');
      commitAll(repo, 'one');
      expect((await changeSet(repo, 'main', { anchor: 'f'.repeat(40) })).range).toBe('HEAD~1..HEAD');
    });

    it('keeps the base range when it has changes', async () => {
      git(repo, 'checkout', '-q', '-b', 'feature');
      write(repo, 'src/one.vue', '1');
      commitAll(repo, 'one');
      expect(await changeSet(repo, 'main', { anchor: (await headCommit(repo))! })).toEqual({
        files: ['src/one.vue'],
        range: 'main...HEAD',
      });
    });
  });

  it('is null-ranged when only uncommitted changes can be considered', async () => {
    const fresh = initRepo();
    write(fresh, 'x.vue', 'x');
    expect(await changeSet(fresh, 'main')).toEqual({ files: ['x.vue'], range: null });
    expect(await headCommit(fresh)).toBeNull();
  });

  it('falls back to uncommitted only when there is no base ref and no HEAD~1', async () => {
    write(repo, 'dirty.txt', 'd');
    expect(await changedFiles(repo, 'no-such-branch')).toEqual(['dirty.txt']);
  });

  it('works before the first commit', async () => {
    const fresh = initRepo();
    write(fresh, 'x.vue', 'x');
    expect(await changedFiles(fresh, 'main')).toEqual(['x.vue']);
  });

  it('tries origin/<baseRef> when the local branch is missing', async () => {
    git(repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'feature');
    write(repo, 'f.txt', 'f');
    commitAll(repo, 'f');
    expect(await changedFiles(repo, 'develop')).toEqual(['f.txt']);
  });

  describe('when repoDir is a subdirectory of the git toplevel', () => {
    it('keeps only paths under it and strips the prefix, for committed and uncommitted changes', async () => {
      write(repo, 'sub/src/App.vue', 'a');
      write(repo, 'sub/src/Old.vue', 'o');
      write(repo, 'other/src/Elsewhere.vue', 'e');
      commitAll(repo, 'add sub');
      git(repo, 'checkout', '-q', '-b', 'feature');
      write(repo, 'sub/src/App.vue', 'changed');
      write(repo, 'other/src/Elsewhere.vue', 'changed');
      commitAll(repo, 'committed');

      write(repo, 'sub/src/New.vue', 'n');
      write(repo, 'other/src/Untracked.vue', 'u');
      git(repo, 'mv', 'sub/src/Old.vue', 'sub/src/Renamed.vue');

      expect(await changedFiles(path.join(repo, 'sub'), 'main')).toEqual([
        'src/App.vue',
        'src/New.vue',
        'src/Old.vue',
        'src/Renamed.vue',
      ]);
      // From the toplevel the same changes keep their full paths.
      expect(await changedFiles(repo, 'main')).toContain('sub/src/App.vue');
    });
  });
});
