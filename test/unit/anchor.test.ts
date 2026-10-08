import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ANCHOR_FILE, ANCHOR_MAX_AGE_MS, anchorKey, resolveAnchor } from '../../src/anchor.js';
import { headCommit } from '../../src/git.js';
import { commitAll, git, initRepo, tmpDir, write } from './helpers.js';

let repo: string;
let statusDir: string;
let clock: number;
const resolve = () => resolveAnchor({ repoDir: repo, statusDir, now: () => clock });
const stored = (): Record<string, { anchor: string; at: string }> => JSON.parse(fs.readFileSync(path.join(statusDir, ANCHOR_FILE), 'utf8'));
const commit = (name: string): void => {
  write(repo, name, name);
  commitAll(repo, name);
};

beforeEach(() => {
  repo = initRepo();
  write(repo, 'a.txt', 'a');
  commitAll(repo, 'initial');
  statusDir = tmpDir('vp-anchor-status-');
  clock = Date.parse('2026-10-08T12:00:00Z');
});

describe('resolveAnchor', () => {
  it('records HEAD for a branch seen for the first time', async () => {
    const head = (await headCommit(repo))!;
    expect(await resolve()).toEqual({ anchor: head, source: 'new' });
    const entries = Object.values(stored());
    expect(entries).toEqual([{ anchor: head, at: '2026-10-08T12:00:00.000Z' }]);
  });

  it('keys by git toplevel and branch', async () => {
    git(repo, 'checkout', '-q', '-b', 'work');
    await resolve();
    expect(Object.keys(stored())).toEqual([anchorKey(fs.realpathSync(repo), 'work')]);
  });

  it('reuses the earliest anchor after a restart on the same branch, even though HEAD moved', async () => {
    git(repo, 'checkout', '-q', '-b', 'work');
    const first = (await resolve()).anchor;
    commit('b.txt');
    commit('c.txt');
    clock += 60_000;
    expect(await resolve()).toEqual({ anchor: first, source: 'reused' });
    expect(first).not.toBe(await headCommit(repo));
    expect(Object.values(stored())).toHaveLength(1);
  });

  it('keeps one anchor per branch', async () => {
    git(repo, 'checkout', '-q', '-b', 'one');
    const one = (await resolve()).anchor;
    commit('b.txt');
    git(repo, 'checkout', '-q', '-b', 'two');
    const two = (await resolve()).anchor;
    expect(two).not.toBe(one);
    commit('c.txt');
    git(repo, 'checkout', '-q', 'one');
    expect((await resolve()).anchor).toBe(one);
    git(repo, 'checkout', '-q', 'two');
    expect((await resolve()).anchor).toBe(two);
  });

  it('starts over from HEAD when the stored anchor is no longer an ancestor (reset, recreated branch)', async () => {
    git(repo, 'checkout', '-q', '-b', 'work');
    commit('b.txt');
    const first = (await resolve()).anchor!;
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    commit('other.txt');
    const result = await resolve();
    expect(result.source).toBe('new');
    expect(result.anchor).toBe(await headCommit(repo));
    expect(result.anchor).not.toBe(first);
    expect(result.discarded).toContain('not an ancestor of HEAD');
    expect(Object.values(stored())[0]!.anchor).toBe(result.anchor);
  });

  it('starts over from HEAD when the stored anchor is older than a day', async () => {
    git(repo, 'checkout', '-q', '-b', 'work');
    const first = (await resolve()).anchor!;
    commit('b.txt');
    clock += ANCHOR_MAX_AGE_MS + 1;
    const result = await resolve();
    expect(result).toMatchObject({ source: 'new', anchor: await headCommit(repo) });
    expect(result.anchor).not.toBe(first);
    expect(result.discarded).toContain('older than 24 h');
  });

  it('survives a torn or foreign anchors file', async () => {
    fs.writeFileSync(path.join(statusDir, ANCHOR_FILE), '{not json');
    expect(await resolve()).toMatchObject({ source: 'new' });
    fs.writeFileSync(path.join(statusDir, ANCHOR_FILE), JSON.stringify({ x: 1, y: { anchor: 3 } }));
    expect(await resolve()).toMatchObject({ source: 'new' });
    expect(Object.keys(stored())).toHaveLength(1); // the two malformed entries are dropped, the real one written
  });

  it('is unpersisted outside a repo and null without commits', async () => {
    const plain = tmpDir('vp-anchor-plain-');
    expect(await resolveAnchor({ repoDir: plain, statusDir, headCommit: async () => 'c'.repeat(40) })).toEqual({
      anchor: 'c'.repeat(40),
      source: 'unpersisted',
    });
    const empty = initRepo();
    expect(await resolveAnchor({ repoDir: empty, statusDir })).toEqual({ anchor: null, source: 'unpersisted' });
    expect(fs.existsSync(path.join(statusDir, ANCHOR_FILE))).toBe(false);
  });

  it('still returns the anchor when the status dir cannot be written', async () => {
    const head = (await headCommit(repo))!;
    const blocked = path.join(statusDir, 'file');
    fs.writeFileSync(blocked, 'x');
    expect(await resolveAnchor({ repoDir: repo, statusDir: blocked })).toMatchObject({ anchor: head, source: 'new' });
  });
});
