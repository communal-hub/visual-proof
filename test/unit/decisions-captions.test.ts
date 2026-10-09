import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DecisionBudget } from '../../src/decisions/budget.js';
import { captionCandidates, classifyChange, pickCaptions, routeTitle, type CaptionSubject } from '../../src/decisions/captions.js';
import { textSidecarPath, readTextSidecar, sweepOrphanSidecars, writeTextSidecar } from '../../src/decisions/sidecar.js';
import { FakeClient, choice, hang, okResult } from './decisions-helpers.js';
import { tmpDir } from './helpers.js';

const VUE = ['<template>', '  <div>hi</div>', '</template>', '', '<script setup>', 'const a = 1', '</script>', '', '<style scoped>', '.a { color: red; }', '</style>', ''].join('\n');
const diffFor = (file: string, hunks: string): string => `diff --git a/${file} b/${file}\nindex 1..2 100644\n--- a/${file}\n+++ b/${file}\n${hunks}`;

describe('classifyChange', () => {
  const read = () => VUE;
  it('maps changed lines of a .vue file to template, script or style', () => {
    expect(classifyChange(diffFor('src/A.vue', '@@ -9,1 +9,1 @@\n-.a { color: blue; }\n+.a { color: red; }\n'), read)).toEqual(['style']);
    expect(classifyChange(diffFor('src/A.vue', '@@ -2,1 +2,1 @@\n-  <div>ho</div>\n+  <div>hi</div>\n'), read)).toEqual(['template']);
    expect(classifyChange(diffFor('src/A.vue', '@@ -6,1 +6,1 @@\n-const a = 0\n+const a = 1\n'), read)).toEqual(['script']);
    expect(classifyChange(diffFor('src/A.vue', '@@ -2,1 +2,1 @@\n-  <div>ho</div>\n+  <div>hi</div>\n@@ -9,1 +9,1 @@\n-.a { color: blue; }\n+.a { color: red; }\n'), read)).toEqual(['style', 'template']);
  });
  it('classifies other files by extension and can be limited to some files', () => {
    const diff = diffFor('src/x.css', '@@ -1 +1 @@\n-a\n+b\n') + diffFor('server/data.json', '@@ -1 +1 @@\n-1\n+2\n') + diffFor('src/main.js', '@@ -1 +1 @@\n-1\n+2\n');
    expect(classifyChange(diff, read)).toEqual(['data', 'script', 'style']);
    expect(classifyChange(diff, read, ['server/data.json'])).toEqual(['data']);
    expect(classifyChange('', read)).toEqual([]);
  });
});

describe('routeTitle', () => {
  const router = `
    const routes = [
      { path: '/', component: Home },
      { path: '/reports', component: Reports, meta: { title: 'Monthly reports' } },
      { path: '/settings', component: Settings, children: [{ path: 'profile', component: Profile, meta: { title: "Your profile" } }] },
      { path: '/about', component: About },
    ]`;
  it('reads meta.title / title after the route path, for full and child paths', () => {
    expect(routeTitle(router, '/reports')).toBe('Monthly reports');
    expect(routeTitle(router, '/settings/profile')).toBe('Your profile');
  });
  it('is null when the route has no title (the next route\'s title is not borrowed)', () => {
    expect(routeTitle(router, '/')).toBeNull();
    expect(routeTitle(router, '/about')).toBeNull();
    expect(routeTitle(router, '/nope')).toBeNull();
  });
});

describe('captions', () => {
  const subject = (extra: Partial<CaptionSubject> = {}): CaptionSubject => ({
    id: 'c0',
    route: '/reports',
    title: 'Monthly reports',
    files: ['src/pages/Reports.vue', 'src/components/StatusBadge.vue'],
    change: ['style'],
    ...extra,
  });
  const opts = (client: FakeClient | null, budgetMs = 5000) => ({ client, model: 'jev', budget: new DecisionBudget(budgetMs), diff: 'diff' });

  it('builds 3 to 5 distinct candidates in code from the title or path, file basenames and change type', () => {
    const candidates = captionCandidates(subject());
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    expect(candidates.length).toBeLessThanOrEqual(5);
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates[0]).toBe('Monthly reports after the style change to Reports.vue, StatusBadge.vue');
    expect(captionCandidates(subject({ title: null, files: [], change: [] }))[0]).toBe('/reports after the content change');
    expect(captionCandidates(subject({ files: ['a.vue', 'b.vue', 'c.vue', 'd.vue', 'e.vue'] }))[0]).toContain('and 2 more');
  });

  it('asks one choice per frame in one request and uses the model\'s pick', async () => {
    const client = new FakeClient((req) => okResult(Object.fromEntries(Object.keys(req.questions).map((id) => [id, choice(id === 'c0' ? 'b' : 'c', 0.8)]))));
    const a = subject();
    const b = subject({ id: 'c1', route: '/about', title: null, files: ['src/pages/About.vue'], change: ['template'] });
    const { captions, note } = await pickCaptions([a, b], opts(client));
    expect(client.calls).toHaveLength(1);
    expect(Object.keys(client.calls[0]!.questions)).toEqual(['c0', 'c1']);
    expect(Object.values(client.calls[0]!.questions).every((q) => q.type === 'choice')).toBe(true);
    expect(captions.get('c0')).toEqual({ caption: captionCandidates(a)[1], source: 'model' });
    expect(captions.get('c1')).toEqual({ caption: captionCandidates(b)[2], source: 'model' });
    expect(note).toBeUndefined();
  });

  it('falls back to the first template with no client, a failed request, a bad pick or no budget', async () => {
    const a = subject();
    const first = captionCandidates(a)[0]!;
    expect((await pickCaptions([a], opts(null))).captions.get('c0')).toEqual({ caption: first, source: 'template' });

    const down = new FakeClient(() => ({ ok: false, kind: 'http', status: 500, error: 'HTTP 500: x', ms: 1 }));
    const failed = await pickCaptions([a], opts(down));
    expect(failed.captions.get('c0')?.source).toBe('template');
    expect(failed.note).toBe('captions use templates: HTTP 500: x');

    const bad = new FakeClient(() => okResult({ c0: choice('zzz') }));
    expect((await pickCaptions([a], opts(bad))).captions.get('c0')).toEqual({ caption: first, source: 'template' });

    const t0 = Date.now();
    const cut = await pickCaptions([a], opts(new FakeClient(hang), 40));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(cut.captions.get('c0')).toEqual({ caption: first, source: 'template' });
    expect(cut.note).toContain('budget exhausted');
  });
});

describe('text sidecar', () => {
  it('lives next to the PNG, is capped, and orphans are swept when the PNG is gone', () => {
    const dir = tmpDir('vp-sidecar-');
    const png = path.join(dir, 'f-000001.png');
    fs.writeFileSync(png, 'png');
    expect(textSidecarPath(png)).toBe(path.join(dir, 'f-000001.text.json'));
    expect(readTextSidecar(png)).toBeNull();
    writeTextSidecar(png, 'x'.repeat(20_000));
    expect(readTextSidecar(png)).toHaveLength(8192);

    const png2 = path.join(dir, 'f-000002.png');
    fs.writeFileSync(png2, 'png');
    writeTextSidecar(png2, 'two');
    fs.rmSync(png); // evicted by the timeline
    sweepOrphanSidecars(dir);
    expect(fs.readdirSync(dir).sort()).toEqual(['f-000002.png', 'f-000002.text.json']);
    expect(readTextSidecar(png2)).toBe('two');
  });
});
