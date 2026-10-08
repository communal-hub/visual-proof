import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FrameEvent } from '../../src/watch.js';
import { createHarness, type Harness } from './harness.js';

const DETAIL = 'src/pages/InvoiceDetail.vue';
const BADGE = 'src/components/StatusBadge.vue';
const DATA = 'server/data.json';
const DETAIL_ROUTE = '/manage/invoices/1';
const LIST_ROUTE = '/manage/invoices';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  await h.start();
});
afterAll(async () => {
  await h?.cleanup();
});

const isRoute = (route: string) => (e: FrameEvent) => e.frame.route === route;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('watch against the vite-vue fixture', () => {
  it('writes status.json as ready with the vite-hmr barrier', () => {
    const status = JSON.parse(fs.readFileSync(path.join(h.dirs.statusDir, 'status.json'), 'utf8'));
    expect(status).toMatchObject({ state: 'ready', trigger: 'fs-watch', barrier: 'vite-hmr', frames: 0, lastError: null });
    expect(status.sessionId).toBe(h.watch!.sessionId);
  });

  it('(a) editing InvoiceDetail.vue yields one clean, logged-in frame of /manage/invoices/1', async () => {
    const from = h.frames.length;
    h.edit(DETAIL, (s) => s.replace('<h1>Invoice</h1>', '<h1>Invoice (a)</h1>'));
    const event = await h.waitForFrame(isRoute(DETAIL_ROUTE), 5000);

    expect(event.frame).toMatchObject({
      route: DETAIL_ROUTE,
      routeKey: '/manage/invoices/:id',
      trigger: 'screen',
      sourceFile: DETAIL,
      status: 'clean',
      reasons: [],
      sessionId: h.watch!.sessionId,
    });
    expect(event.frame.treeHash).toMatch(/^[0-9a-f]{40}$/);
    // Logged in (not bounced to /login) and the fresh edit is on screen, data loaded.
    expect(event.signals.text).toContain('Invoice (a)');
    expect(event.signals.text).toContain('INV-001');
    expect(fs.statSync(event.pngPath).size).toBeGreaterThan(1000);
    expect(fs.readFileSync(event.pngPath).subarray(1, 4).toString()).toBe('PNG');

    // Exactly one frame for the single save.
    await sleep(1000);
    expect(h.frames.slice(from).map((f) => f.frame.route)).toEqual([DETAIL_ROUTE]);

    const status = JSON.parse(fs.readFileSync(path.join(h.dirs.statusDir, 'status.json'), 'utf8'));
    expect(status).toMatchObject({ state: 'ready', frames: h.frames.length });
    expect(status.lastCaptureAt).toBe(event.frame.at);
    expect(fs.readFileSync(path.join(h.dirs.statusDir, 'watcher.log'), 'utf8')).toMatch(/^\S+ frame f-\d+ \/manage\/invoices\/1 clean/m);
  });

  it('(b) editing the shared StatusBadge.vue captures both pages that render it', async () => {
    const from = h.frames.length;
    h.edit(BADGE, (s) => s.replace('.badge-paid { background: #cfc; }', '.badge-paid { background: #afa; }'));
    await h.waitForFrame(isRoute(DETAIL_ROUTE), 8000, { from });
    await h.waitForFrame(isRoute(LIST_ROUTE), 8000, { from });
    await sleep(800);

    const routes = h.frames.slice(from).map((f) => f.frame.route).sort();
    expect(routes).toEqual([LIST_ROUTE, DETAIL_ROUTE].sort());
    for (const e of h.frames.slice(from)) {
      expect(e.frame.status).toBe('clean');
      expect(e.frame.sourceFile).toBe(BADGE);
    }
  });

  it('(c) editing the backend data re-captures every route of the session with the new value', async () => {
    const from = h.frames.length;
    h.edit(DATA, (s) => s.replace('INV-001', 'INV-001-REVISED'));
    const event = await h.waitForFrame(isRoute(DETAIL_ROUTE), 8000, { from });
    expect(event.frame).toMatchObject({ trigger: 'backend', sourceFile: DATA, status: 'clean' });
    expect(event.signals.text).toContain('INV-001-REVISED');

    const list = await h.waitForFrame(isRoute(LIST_ROUTE), 8000, { from });
    expect(list.frame.trigger).toBe('backend');
    expect(list.signals.text).toContain('INV-001-REVISED');
  });

  it('the tree hash on each frame matches the working tree, so a commit makes it the HEAD frame', async () => {
    const last = h.frames[h.frames.length - 1]!;
    const tree = h.commitAll('all edits so far');
    expect(h.timeline().latestAtTree(DETAIL_ROUTE, tree)).toBeDefined();
    expect(last.frame.treeHash).toBe(tree);
  });

  it('(e) save-to-still latency', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 6; i++) {
      const marker = `latency-${i}`;
      const t0 = Date.now();
      h.edit(DETAIL, (s) => s.replace(/<h1>[^<]*<\/h1>/, `<h1>${marker}</h1>`));
      const event = await h.waitForFrame((e) => e.frame.route === DETAIL_ROUTE && e.signals.text.includes(marker), 5000);
      samples.push(Date.now() - t0);
      expect(event.frame.status).toBe('clean');
      await sleep(300);
    }
    const warm = samples.slice(1).sort((a, b) => a - b);
    const median = warm[Math.floor(warm.length / 2)]!;
    console.log(
      `save-to-still latency (ms): first=${samples[0]} warm=[${samples.slice(1).join(', ')}] warm median=${median} (target < 1000)`,
    );
    const log = fs.readFileSync(path.join(h.dirs.statusDir, 'watcher.log'), 'utf8').split('\n');
    console.log(log.filter((l) => l.includes('timing') || l.includes('barrier=')).slice(-6).join('\n'));
    expect(samples.every((ms) => ms < 5000)).toBe(true);
  });

  it('(d) with the freshness marker gone, a save is refused and records no frame', async () => {
    const marker = path.join(h.dir, '.visual-proof/hot');
    const contents = fs.readFileSync(marker, 'utf8');
    fs.rmSync(marker);
    const from = h.frames.length;

    const refused = h.waitForEvent<{ reason: string; screen: string[] }>('refused', 5000);
    h.edit(DETAIL, (s) => s.replace(/<h1>[^<]*<\/h1>/, '<h1>stale</h1>'));
    expect((await refused).reason).toBe('stale: freshness marker missing, capture refused');
    await sleep(1000);
    expect(h.frames.length).toBe(from);
    expect(fs.readFileSync(path.join(h.dirs.statusDir, 'watcher.log'), 'utf8')).toContain(
      'stale: freshness marker missing, capture refused',
    );

    // Restoring the marker lets the next save through again.
    fs.writeFileSync(marker, contents);
    h.edit(DETAIL, (s) => s.replace(/<h1>[^<]*<\/h1>/, '<h1>fresh again</h1>'));
    const event = await h.waitForFrame((e) => e.signals.text.includes('fresh again'), 5000);
    expect(event.frame.status).toBe('clean');
  });
});
