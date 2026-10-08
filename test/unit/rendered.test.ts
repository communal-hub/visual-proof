import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MAX_RENDERED_FILES, normalizeRenderedFiles, renderedFilesScript } from '../../src/rendered.js';
import { tmpDir } from './helpers.js';

// Fake Vue 3 internals: just the fields the walker reads (`component`, `subTree`, `children`, `suspense`).
type VNode = Record<string, unknown>;
const comp = (file: string | undefined, subTree: VNode | null): VNode => ({
  type: {},
  component: { type: file === undefined ? {} : { __file: file }, subTree },
});
const el = (...children: unknown[]): VNode => ({ type: 'div', children });
const text = (): VNode => ({ type: 'Text', children: 'hello' });

/** Run the in-page script against a fake document whose root element carries `app`. */
function walk(app: unknown, appRoot = '#app'): string[] | null {
  const root = app === undefined ? {} : { __vue_app__: app };
  const document = { querySelector: (sel: string) => (sel === appRoot ? root : null) };
  return vm.runInNewContext(renderedFilesScript(appRoot), { document }) as string[] | null;
}
const appOf = (rootFile: string, subTree: VNode | null) => ({ _instance: { type: { __file: rootFile }, subTree } });
const sorted = (files: string[] | null) => (files ? [...files].sort() : files);

describe('renderedFilesScript', () => {
  it('collects nested components through elements, fragments and slots', () => {
    const deep = comp('/r/src/components/Badge.vue', el(text()));
    const page = comp('/r/src/pages/Detail.vue', el(el(deep, text()), { type: 'Fragment', children: [comp('/r/src/components/Row.vue', null)] }));
    const layout = comp('/r/src/layouts/Shell.vue', el(page));
    expect(sorted(walk(appOf('/r/src/App.vue', el(layout))))).toEqual([
      '/r/src/App.vue',
      '/r/src/components/Badge.vue',
      '/r/src/components/Row.vue',
      '/r/src/layouts/Shell.vue',
      '/r/src/pages/Detail.vue',
    ]);
  });

  it('does not report a component that a v-if left out (a comment vnode has no component)', () => {
    const tree = el(comp('/r/src/pages/P.vue', el({ type: 'Comment', children: 'v-if' })));
    expect(sorted(walk(appOf('/r/src/App.vue', tree)))).toEqual(['/r/src/App.vue', '/r/src/pages/P.vue']);
  });

  it('follows Suspense to the branch it shows now, not to the one still pending', () => {
    const shown = comp('/r/src/pages/Resolved.vue', el());
    const pending = comp('/r/src/pages/Pending.vue', el());
    const suspense = { type: 'Suspense', suspense: { activeBranch: shown, pendingBranch: pending }, ssContent: pending, children: null };
    expect(sorted(walk(appOf('/r/src/App.vue', el(suspense))))).toEqual(['/r/src/App.vue', '/r/src/pages/Resolved.vue']);

    const fallback = comp('/r/src/components/Spinner.vue', el());
    const loading = { type: 'Suspense', suspense: { activeBranch: fallback, pendingBranch: pending }, children: null };
    expect(sorted(walk(appOf('/r/src/App.vue', el(loading))))).toEqual(['/r/src/App.vue', '/r/src/components/Spinner.vue']);
  });

  it('follows KeepAlive to its active child only (the instance subTree), and Teleport children', () => {
    const active = comp('/r/src/pages/Active.vue', el());
    const keepAlive = { type: 'KeepAlive', component: { type: { __isKeepAlive: true }, subTree: active } };
    const teleported = comp('/r/src/components/Modal.vue', el());
    const teleport = { type: 'Teleport', children: [teleported] };
    expect(sorted(walk(appOf('/r/src/App.vue', el(keepAlive, teleport))))).toEqual([
      '/r/src/App.vue',
      '/r/src/components/Modal.vue',
      '/r/src/pages/Active.vue',
    ]);
  });

  it('survives shared vnodes and cycles', () => {
    const shared = comp('/r/src/components/Shared.vue', null);
    const loop = el(shared);
    (loop.children as unknown[]).push(loop);
    expect(sorted(walk(appOf('/r/src/App.vue', el(shared, loop))))).toEqual(['/r/src/App.vue', '/r/src/components/Shared.vue']);
  });

  it('handles a very deep tree without overflowing the stack', () => {
    let node: VNode = comp('/r/src/components/Leaf.vue', null);
    for (let i = 0; i < 20_000; i++) node = el(node);
    expect(sorted(walk(appOf('/r/src/App.vue', node)))).toEqual(['/r/src/App.vue', '/r/src/components/Leaf.vue']);
  });

  it('falls back to the root vnode when the app has no _instance', () => {
    const app = {};
    const document = { querySelector: () => ({ __vue_app__: app, _vnode: comp('/r/src/App.vue', null) }) };
    expect(vm.runInNewContext(renderedFilesScript('#app'), { document })).toEqual(['/r/src/App.vue']);
  });

  it('is null without a Vue 3 app, without any __file (production build), or without the root element', () => {
    expect(walk(undefined)).toBeNull();
    expect(walk(appOf('', el(comp(undefined, el()))))).toBeNull();
    const document = { querySelector: () => null };
    expect(vm.runInNewContext(renderedFilesScript('#app'), { document })).toBeNull();
    const broken = { querySelector: () => { throw new Error('bad selector'); } };
    expect(vm.runInNewContext(renderedFilesScript('##'), { document: broken })).toBeNull();
  });
});

describe('normalizeRenderedFiles', () => {
  const repo = tmpDir('vp-rendered-');

  it('makes absolute paths repo-relative POSIX, drops outsiders, dedupes and sorts', () => {
    expect(
      normalizeRenderedFiles(
        [path.join(repo, 'src/B.vue'), path.join(repo, 'src/A.vue'), path.join(repo, 'src/A.vue'), '/elsewhere/node_modules/x/X.vue', path.join(repo, '..', 'sibling/S.vue')],
        repo,
      ),
    ).toEqual(['src/A.vue', 'src/B.vue']);
  });

  it('keeps relative paths (a build that stamps them) and strips ./', () => {
    expect(normalizeRenderedFiles(['./src/A.vue', 'src/B.vue'], repo)).toEqual(['src/A.vue', 'src/B.vue']);
  });

  it('is null when nothing lies inside the repo (paths cannot be compared), or when there is nothing', () => {
    expect(normalizeRenderedFiles(['/app/src/A.vue'], repo)).toBeNull();
    expect(normalizeRenderedFiles([], repo)).toBeNull();
    expect(normalizeRenderedFiles(null, repo)).toBeNull();
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_RENDERED_FILES + 50 }, (_, i) => path.join(repo, `src/C${i}.vue`));
    expect(normalizeRenderedFiles(many, repo)).toHaveLength(MAX_RENDERED_FILES);
  });
});
