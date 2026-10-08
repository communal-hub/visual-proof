import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Browser } from '../../src/browser.js';
import { DETAIL, DETAIL_ROUTE, sleep } from '../corpus/helpers.js';
import { createHarness } from './harness.js';

/**
 * Measures `settle.networkIdleMs` on the fixture. Off by default (it takes minutes):
 *
 *   VP_BENCH=1 npx vitest run test/integration/settle-bench.test.ts
 *   VP_BENCH_IDLE=500,250,150 VP_BENCH_SAMPLES=5 VP_BENCH_PASSES=3   (the defaults)
 *   VP_BENCH_OUT=/tmp/vp-settle-bench.json                           (where the table is written)
 *
 * For each idle window: the warm save-to-still latency (edit a page, wait for its still), the settle and
 * screenshot timing recorded on those frames, and a sweep that captures every fixture route several times,
 * alone and four at a time (CPU contention), counting captures that are not clean or whose text differs from the
 * first capture of the route (a half-loaded page).
 */
const bench = process.env.VP_BENCH ? describe : describe.skip;

const IDLE = (process.env.VP_BENCH_IDLE ?? '500,250,150').split(',').map(Number);
const SAMPLES = Number(process.env.VP_BENCH_SAMPLES ?? 5);
const PASSES = Number(process.env.VP_BENCH_PASSES ?? 3);
const ROUTES = ['/', '/reports', '/manage/invoices', DETAIL_ROUTE, '/long', '/flagged', '/settings', '/settings/profile', '/about'];

/** Extra fixture config for the run, e.g. VP_BENCH_CONFIG='{"blockHosts":[]}' to measure without request interception. */
const extraConfig = JSON.parse(process.env.VP_BENCH_CONFIG ?? '{}') as Record<string, unknown>;

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

bench('settle benchmark', () => {
  const rows: Array<Record<string, unknown>> = [];

  for (const networkIdleMs of IDLE) {
    it(`networkIdleMs ${networkIdleMs}`, async () => {
      const h = await createHarness({ config: { ...extraConfig, settle: { networkIdleMs } } });
      try {
        await h.start();
        const samples: number[] = [];
        const settle: number[] = [];
        const shot: number[] = [];
        let nonClean = 0;
        for (let i = -1; i < SAMPLES; i++) {
          const marker = `bench-${networkIdleMs}-${i}`;
          const t0 = Date.now();
          h.edit(DETAIL, (s) => s.replace(/<h1>[^<]*<\/h1>/, `<h1>${marker}</h1>`));
          const event = await h.waitForFrame((e) => e.frame.route === DETAIL_ROUTE && e.signals.text.includes(marker), 15_000);
          if (i >= 0) {
            samples.push(Date.now() - t0);
            settle.push(event.frame.timing?.settleMs ?? 0);
            shot.push(event.frame.timing?.screenshotMs ?? 0);
            if (event.frame.status !== 'clean') nonClean++;
          }
          await sleep(300);
        }
        await h.stopWatch();

        const browser = await Browser.launch(h.config);
        try {
          const first = new Map<string, string>();
          let captures = 0;
          let sweepBad = 0;
          const one = async (route: string): Promise<void> => {
            const r = await browser.capture(h.appUrl + route);
            captures++;
            const text = r.signals.text;
            if (!first.has(route)) first.set(route, text);
            const bad = r.signals.visibleSpinnerCount > 0 || !r.signals.appRootPresent || r.signals.consoleErrors.length > 0 || text !== first.get(route);
            if (bad) {
              sweepBad++;
              console.warn(`non-clean capture at ${networkIdleMs} ms: ${route} ${JSON.stringify({ text: text.slice(0, 80), spinners: r.signals.visibleSpinnerCount })}`);
            }
          };
          // The first pass of each route sets the reference text; a warm-up pass keeps Vite's first compile out of it.
          for (const route of ROUTES) await one(route);
          first.clear();
          captures = 0;
          sweepBad = 0;
          for (let pass = 0; pass < PASSES; pass++) {
            for (const route of ROUTES) await one(route);
            for (let i = 0; i < ROUTES.length; i += 4) await Promise.all(ROUTES.slice(i, i + 4).map(one));
          }
          rows.push({
            networkIdleMs,
            samplesMs: samples,
            medianMs: median(samples),
            settleMedianMs: median(settle),
            screenshotMedianMs: median(shot),
            nonCleanFrames: nonClean,
            sweepCaptures: captures,
            sweepNonClean: sweepBad,
          });
          expect(nonClean + sweepBad).toBe(0);
        } finally {
          await browser.close();
        }
      } finally {
        await h.cleanup();
        // vitest swallows console output of passing tests; the file is where the numbers are.
        fs.writeFileSync(process.env.VP_BENCH_OUT ?? '/tmp/vp-settle-bench.json', `${JSON.stringify(rows, null, 2)}\n`);
      }
    });
  }
});
