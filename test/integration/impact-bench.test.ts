import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BatchEvent, FrameEvent } from '../../src/watch.js';
import { createHarness } from './harness.js';
import { generateRoutes, PICKER } from './many-routes.js';

/**
 * Measures a shared-component save on the 200-route fixture. Off by default (it takes minutes):
 *
 *   VP_BENCH=1 npx vitest run test/integration/impact-bench.test.ts
 *   VP_BENCH_CONCURRENCY=1,2,3 VP_BENCH_SAMPLES=3 VP_BENCH_MAX_IMPACT=40   (the defaults; "default" leaves
 *   focus.impactConcurrency to the config default, which is what the hill-climb measures)
 *   VP_BENCH_OUT=/tmp/vp-impact-bench.json                                  (where the table is written)
 *
 * Per run: save -> the claim screen's frame, save -> the batch is fully captured, the wall time per capture, and the
 * settle / screenshot split the frames record. Only frame and batch events are used, so it also runs against older
 * watchers (pass `focus.impactConcurrency` through VP_BENCH_CONFIG only where it exists).
 */
const bench = process.env.VP_BENCH ? describe : describe.skip;
const CONCURRENCY = (process.env.VP_BENCH_CONCURRENCY ?? '1,2,3').split(',').map(Number);
const SAMPLES = Number(process.env.VP_BENCH_SAMPLES ?? 3);
const MAX_IMPACT = Number(process.env.VP_BENCH_MAX_IMPACT ?? 40);
const CLAIMED = '/gen/p150';
const extraConfig = JSON.parse(process.env.VP_BENCH_CONFIG ?? '{}') as Record<string, unknown>;

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

bench('impact benchmark', () => {
  const rows: Array<Record<string, unknown>> = [];
  for (const concurrency of CONCURRENCY) {
    it(`impactConcurrency ${concurrency}`, async () => {
      const focus = { maxImpact: MAX_IMPACT, ...(process.env.VP_BENCH_OLD || Number.isNaN(concurrency) ? {} : { impactConcurrency: concurrency }) };
      const h = await createHarness({ prepare: generateRoutes, config: { replay: { enabled: false }, ...extraConfig, focus } });
      try {
        fs.writeFileSync(path.join(h.dirs.statusDir, 'claim.md'), `- ${CLAIMED}: the picker\n`);
        const handle = await h.start();
        const claimMs: number[] = [];
        const batchMs: number[] = [];
        const perCapture: number[] = [];
        const settle: number[] = [];
        const shot: number[] = [];
        let nonClean = 0;
        let stale = 0;
        let captures = 0;
        for (let i = -1; i < SAMPLES; i++) {
          const from = h.frames.length;
          const t0 = Date.now();
          const batch = new Promise<BatchEvent>((resolve) => {
            const on = (b: BatchEvent) => {
              if (!b.screen.includes(PICKER)) return;
              handle.events.off('batch', on);
              resolve(b);
            };
            handle.events.on('batch', on);
          });
          const marker = `Pick a date ${concurrency}-${i}-${Date.now().toString(36)}`;
          h.edit(PICKER, (s) => s.replace(/Pick a date[^<]*/, `${marker} `));
          await h.waitForFrame((e: FrameEvent) => e.frame.route === CLAIMED, 120_000, { from });
          const claimAt = Date.now() - t0;
          await batch;
          const doneAt = Date.now() - t0;
          const frames = h.frames.slice(from);
          if (i >= 0) {
            // Speed must not come from capturing too early: every frame has to be clean and show this save.
            nonClean += frames.filter((f) => f.frame.status !== 'clean').length;
            stale += frames.filter((f) => !f.signals.text.includes(marker)).length;
            captures += frames.length;
            claimMs.push(claimAt);
            batchMs.push(doneAt);
            perCapture.push(Math.round(doneAt / frames.length));
            settle.push(median(frames.map((f) => f.frame.timing?.settleMs ?? 0)));
            shot.push(median(frames.map((f) => f.frame.timing?.screenshotMs ?? 0)));
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        rows.push({
          concurrency: process.env.VP_BENCH_OLD ? 'v0.12' : Number.isNaN(concurrency) ? 'default' : concurrency,
          captures: captures / SAMPLES,
          nonClean,
          stale,
          claimFrameMs: median(claimMs),
          batchMs: median(batchMs),
          msPerCapture: median(perCapture),
          settleMs: median(settle),
          screenshotMs: median(shot),
        });
      } finally {
        await h.cleanup();
      }
    }, 900_000);
  }
  it('writes the table', () => {
    console.table(rows);
    // One configuration is written as a flat object (the hill-climb's measurement), several as an array.
    fs.writeFileSync(process.env.VP_BENCH_OUT ?? '/tmp/vp-impact-bench.json', `${JSON.stringify(rows.length === 1 ? rows[0] : rows, null, 2)}\n`);
  });
});
