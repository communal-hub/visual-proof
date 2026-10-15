import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FrameEvent } from '../../src/watch.js';
import { createHarness, type Harness } from './harness.js';
import { generateRoutes, PAGES, PICKER } from './many-routes.js';

/**
 * v0.13 acceptance: a shared component reachable from 200 routes, a claim that names one screen. The watcher captures
 * the claim screen first, `ready --claim` returns without waiting for the impact routes, and `finish` passes right away.
 */

const CLAIMED = '/gen/p150';

let h: Harness;
const statusJson = () => JSON.parse(fs.readFileSync(path.join(h.dirs.statusDir, 'status.json'), 'utf8'));
const logText = () => fs.readFileSync(path.join(h.dirs.statusDir, 'watcher.log'), 'utf8');

beforeAll(async () => {
  h = await createHarness({ prepare: generateRoutes, config: { replay: { enabled: false } } });
  fs.writeFileSync(path.join(h.dirs.statusDir, 'claim.md'), `- ${CLAIMED}: the date picker says "Choose a date"\n`);
  await h.start();
}, 180_000);
afterAll(async () => {
  await h?.cleanup();
});

describe('claim screens first, with a component shared by 200 routes', () => {
  it('ready --claim returns in under 60 s after the save, while impact routes are still queued', async () => {
    const from = h.frames.length;
    h.edit(PICKER, (s) => s.replace('Pick a date', 'Choose a date'));
    const t0 = Date.now();
    const ready = await h.cli('ready', '--claim', '--timeout', '120');
    const ms = Date.now() - t0;
    expect(ready.stderr).toBe('');
    expect(ready.code).toBe(0);
    expect(ms).toBeLessThan(60_000);
    const status = JSON.parse(ready.stdout);
    expect(status.claim).toMatchObject({ ready: true, current: true, total: 1, captured: 1, screens: [{ screen: CLAIMED, state: 'clean' }] });
    const claimFrame = h.frames.slice(from).find((f) => f.frame.route === CLAIMED)!;
    expect(claimFrame.frame.status).toBe('clean');
    expect(claimFrame.signals.text).toContain('Choose a date');
    // The claim screen was the first capture of the batch.
    expect(h.frames.slice(from)[0]!.frame.route).toBe(CLAIMED);
    console.log(`[acceptance] ready --claim after the save: ${ms} ms; impact still queued then: ${JSON.stringify(status.remaining ?? null)}`);
  }, 120_000);

  it('finish passes in under 90 s without a prior wait', async () => {
    h.commitAll('picker label');
    const t0 = Date.now();
    const result = await h.finish();
    const ms = Date.now() - t0;
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(ms).toBeLessThan(90_000);
    const claimed = result.routes.find((r) => r.route === CLAIMED)!;
    expect(claimed).toMatchObject({ role: 'headline', headlineReason: 'claim', status: 'clean' });
    expect(result.impact!.total).toBe(PAGES - 1);
    console.log(`[acceptance] finish without a prior wait: ${ms} ms; impact ${JSON.stringify({ clean: result.impact!.clean, notCaptured: result.impact!.notCaptured.length })}`);
  }, 120_000);

  it('rewriting a backend file with identical content drops no frames and captures nothing', async () => {
    // Let the impact batch of the save above finish first, so a stray batch cannot be mistaken for this one.
    await waitIdle();
    const discarded = h.events.discarded.length;
    const frames = h.frames.length;
    const data = path.join(h.dir, 'server/data.json');
    fs.writeFileSync(data, fs.readFileSync(data));
    await new Promise((r) => setTimeout(r, 1500));
    expect(h.events.discarded.length).toBe(discarded);
    expect(h.frames.length).toBe(frames);
    expect(logText()).toContain('ignored: server/data.json written with the same content');
  }, 180_000);

  it('a backend file rewritten with identical content during a capture keeps the frames', async () => {
    await waitIdle();
    const discarded = h.events.discarded.length;
    const from = h.frames.length;
    const data = path.join(h.dir, 'server/data.json');
    h.edit(PICKER, (s) => s.replace('Choose a date', 'Choose a day'));
    await h.waitForFrame((e) => e.frame.route === CLAIMED, 30_000, { from });
    fs.writeFileSync(data, fs.readFileSync(data)); // a regeneration mid-capture, e.g. a translation catalogue
    await waitIdle();
    expect(h.events.discarded.length).toBe(discarded);
    expect(h.frames.length - from).toBeGreaterThan(1);
  }, 240_000);

  it('amending a sidecar re-runs only that sidecar', async () => {
    await waitIdle();
    const one = h.writeSidecar('one', `goto ${CLAIMED}\nstill picker\n`);
    const two = h.writeSidecar('two', 'goto /gen/p2\nstill picker\n');
    await h.waitForFrame((e) => e.frame.route === `sidecar:${two}#picker`, 60_000, { from: 0 }).catch(() => {});
    await waitIdle();
    h.commitAll('sidecars');
    await waitIdle();
    const from = h.frames.length;
    h.edit(one, (s) => s.replace('still picker', 'wait [data-test=picker]\nstill picker'));
    h.git('commit', '-q', '-a', '--amend', '--no-edit');
    await h.waitForFrame((e) => e.frame.route === `sidecar:${one}#picker`, 60_000, { from });
    await waitIdle();
    const routes = h.frames.slice(from).map((f: FrameEvent) => f.frame.route);
    expect(new Set(routes)).toEqual(new Set([`sidecar:${one}#picker`]));
  }, 240_000);

  it('sidecar try reports a broken selector with its line number in under 15 s', async () => {
    const file = h.writeSidecar('broken', `goto ${CLAIMED}\nclick [data-test=picker]\nclick [data-test=no-such-button]\nstill after\n`);
    const t0 = Date.now();
    const tried = await h.cli('sidecar', 'try', path.join(h.dir, file));
    const ms = Date.now() - t0;
    expect(tried.code).toBe(1);
    expect(tried.stdout).toMatch(/FAIL line 3 {2}click \[data-test=no-such-button\] \(\d+ ms\): selector not found/);
    expect(tried.stdout).toMatch(/failed at \.visual-proof\/sidecars\/broken\.vp:3/);
    expect(ms).toBeLessThan(15_000);
    console.log(`[acceptance] sidecar try with a broken selector: ${ms} ms`);
  }, 60_000);
});

async function waitIdle(timeoutMs = 170_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = statusJson();
    if (status.state === 'ready' && status.pending === false) return;
    if (Date.now() > deadline) throw new Error(`watcher not idle after ${timeoutMs} ms: ${JSON.stringify({ state: status.state, remaining: status.remaining })}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
