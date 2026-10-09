import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globBase, startFsWatch, type FsWatchHandle, type WatchBatch } from '../../src/trigger/fs-watch.js';
import { tmpDir, write } from './helpers.js';

let root: string;
let handle: FsWatchHandle | null;
let batches: WatchBatch[];

beforeEach(() => {
  root = tmpDir('vp-watch-');
  batches = [];
  handle = null;
  write(root, 'src/a.vue', 'a');
  write(root, 'src/b.vue', 'b');
  write(root, 'src/notes.md', 'n');
  write(root, 'server/data.json', '{}');
  write(root, 'other/x.vue', 'x');
  write(root, 'node_modules/pkg/src/x.vue', 'x');
  write(root, '.status/log.vue', 'x');
});
afterEach(async () => {
  await handle?.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

function start(overrides: Partial<Parameters<typeof startFsWatch>[0]> = {}): Promise<FsWatchHandle> {
  return startFsWatch({
    repoDir: root,
    screenGlobs: ['src/**/*.vue'],
    backendGlobs: ['server/**'],
    ignorePaths: [path.join(root, '.status')],
    onBatch: (b) => batches.push(b),
    ...overrides,
  }).then((h) => (handle = h));
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('startFsWatch', () => {
  it('counts every relevant file event monotonically, even ones coalesced into a single batch', async () => {
    const h = await start({ debounceMs: 200 });
    expect(h.eventCount()).toBe(0);
    write(root, 'src/notes.md', 'ignored');
    write(root, 'other/x.vue', 'ignored');
    await sleep(100);
    expect(h.eventCount()).toBe(0);

    write(root, 'src/a.vue', 'a2');
    await until(() => h.eventCount() >= 1);
    const first = h.eventCount();
    write(root, 'server/data.json', '{"n":2}');
    await until(() => h.eventCount() >= first + 1);
    await until(() => batches.length > 0);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ screen: ['src/a.vue'], backend: ['server/data.json'] });
    const settled = h.eventCount();
    await sleep(100);
    expect(h.eventCount()).toBe(settled);
  });

  it('does not report files matching ignoreScreenGlobs as screens', async () => {
    write(root, 'src/stories/s.vue', 's');
    await start({ ignoreScreenGlobs: ['src/stories/**'] });
    write(root, 'src/stories/s.vue', 's2');
    write(root, 'src/a.vue', 'a2');
    await until(() => batches.length > 0);
    await sleep(300);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ screen: ['src/a.vue'], backend: [] });
  });

  it('classifies changes into screen and backend, as repo-relative POSIX paths', async () => {
    await start();
    write(root, 'src/a.vue', 'a2');
    write(root, 'server/data.json', '{"x":1}');
    await until(() => batches.length > 0);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ screen: ['src/a.vue'], backend: ['server/data.json'] });
  });

  it('coalesces a burst of events into one debounced batch', async () => {
    await start({ debounceMs: 150 });
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      write(root, 'src/a.vue', `a${i}`);
      write(root, 'src/b.vue', `b${i}`);
      await sleep(30);
    }
    await until(() => batches.length > 0);
    await sleep(300);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.screen).toEqual(['src/a.vue', 'src/b.vue']);
    expect(batches[0]!.startedAt).toBeGreaterThanOrEqual(t0);
  });

  it('emits a second batch for changes after the quiet period', async () => {
    await start({ debounceMs: 60 });
    write(root, 'src/a.vue', '1');
    await until(() => batches.length === 1);
    write(root, 'src/b.vue', '2');
    await until(() => batches.length === 2);
    expect(batches.map((b) => b.screen)).toEqual([['src/a.vue'], ['src/b.vue']]);
  });

  it('reports new files and deletions', async () => {
    await start({ debounceMs: 60 });
    write(root, 'src/new/Deep.vue', 'd');
    await until(() => batches.length === 1);
    expect(batches[0]!.screen).toEqual(['src/new/Deep.vue']);
    fs.rmSync(path.join(root, 'src/a.vue'));
    await until(() => batches.length === 2);
    expect(batches[1]!.screen).toEqual(['src/a.vue']);
  });

  it('ignores files that match no glob, node_modules, .git and the status dirs', async () => {
    await start({
      debounceMs: 60,
      screenGlobs: ['src/**/*.vue', '**/*.vue'],
      ignorePaths: [path.join(root, '.status')],
    });
    write(root, 'src/notes.md', 'changed');
    write(root, 'node_modules/pkg/src/x.vue', 'changed');
    write(root, '.git/hooks/x.vue', 'changed');
    write(root, '.status/log.vue', 'changed');
    await sleep(400);
    expect(batches).toEqual([]);
    write(root, 'other/x.vue', 'changed');
    await until(() => batches.length === 1);
    expect(batches[0]!.screen).toEqual(['other/x.vue']);
  });

  it('puts a file that matches both glob sets in both lists', async () => {
    await start({ debounceMs: 60, screenGlobs: ['src/**'], backendGlobs: ['src/**/*.vue'] });
    write(root, 'src/a.vue', 'x');
    await until(() => batches.length === 1);
    expect(batches[0]).toMatchObject({ screen: ['src/a.vue'], backend: ['src/a.vue'] });
  });

  it('stops cleanly: no batch after stop, even with one pending', async () => {
    const h = await start({ debounceMs: 200 });
    write(root, 'src/a.vue', 'x');
    await sleep(60);
    await h.stop();
    await sleep(400);
    expect(batches).toEqual([]);
    await expect(h.stop()).resolves.toBeUndefined();
  });

  it('works with awaitWriteFinish enabled', async () => {
    await start({ debounceMs: 60, awaitWriteFinish: true });
    write(root, 'src/a.vue', 'x');
    await until(() => batches.length === 1);
    expect(batches[0]!.screen).toEqual(['src/a.vue']);
  });
});

describe('sidecar files', () => {
  it('reports sidecar files in their own list, keeps them out of screen and backend, and sees one created after start', async () => {
    write(root, '.visual-proof/sidecars/a.vp', 'goto /\nstill s\n');
    await start({ sidecarGlobs: ['.visual-proof/sidecars/*.vp'], screenGlobs: ['**/*.vue', '.visual-proof/**/*.vp'] }); // a sidecar also matching a screen glob stays a sidecar
    write(root, '.visual-proof/sidecars/a.vp', 'goto /\nstill t\n');
    write(root, '.visual-proof/sidecars/new.vp', 'goto /\nstill u\n');
    write(root, '.visual-proof/sidecars/ignored.txt', 'x');
    await until(() => batches.length > 0);
    await sleep(300);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      screen: [],
      backend: [],
      sidecar: ['.visual-proof/sidecars/a.vp', '.visual-proof/sidecars/new.vp'],
    });
  });

  it('creates the watch for a sidecar directory that does not exist yet', async () => {
    await start({ sidecarGlobs: ['scenarios/*.vp'] });
    write(root, 'scenarios/late.vp', 'goto /\nstill s\n');
    await until(() => batches.length > 0, 5000);
    expect(batches[0]!.sidecar).toEqual(['scenarios/late.vp']);
  });
});

describe('globBase', () => {
  it.each([
    ['src/**', 'src'],
    ['src/**/*.vue', 'src'],
    ['**/*.vue', ''],
    ['resources/assets/js/**/*.{js,ts}', 'resources/assets/js'],
    ['./server/**', 'server'],
    ['server/data.json', 'server'],
    ['data.json', ''],
  ])('%s -> %j', (glob, base) => {
    expect(globBase(glob)).toBe(base);
  });
});
