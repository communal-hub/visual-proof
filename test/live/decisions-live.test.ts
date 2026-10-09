import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DecisionBudget } from '../../src/decisions/budget.js';
import { DecisionsClient, noulAnswer } from '../../src/decisions/client.js';
import { DEFAULT_TEXT_MODEL, DEFAULT_TRIAGE_MODEL } from '../../src/decisions/config.js';
import { probeModels } from '../../src/decisions/doctor.js';
import { IMAGE_TOKEN_GUARD, checkImages } from '../../src/decisions/image-check.js';
import { LIVE_KEY, still } from '../live.js';
import { createHarness, type Harness } from '../integration/harness.js';
import { DETAIL, DETAIL_ROUTE, REPORTS, REPORTS_ROUTE, forRoute, readBlock, setHeading } from '../corpus/helpers.js';

/**
 * Live tests against the real OpenRouter Decisions API (a few requests, fractions of a cent). They run only
 * when OPENROUTER_API_KEY is available (environment as VP_LIVE_OPENROUTER_API_KEY after test/setup.ts, or the
 * worktree's .env). Thresholds are generous: labels and orderings, never exact probabilities or latencies.
 */
const live = describe.skipIf(!LIVE_KEY);

const client = new DecisionsClient({ apiKey: LIVE_KEY ?? 'unused', timeoutMs: 15_000 });
const report: Record<string, unknown> = { latenciesMs: {} as Record<string, number> };
const lat = report.latenciesMs as Record<string, number>;
const budget = () => new DecisionBudget(20_000);

afterAll(() => {
  if (!LIVE_KEY) return;
  report.totals = { ...client.stats };
  fs.writeFileSync(path.join(os.tmpdir(), 'vp-live-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`live decisions: ${client.stats.requests} requests, $${client.stats.cost.toFixed(6)} (this client), see ${path.join(os.tmpdir(), 'vp-live-report.json')}`);
});

live('Luna frame triage on real fixture stills', () => {
  const expectations = [
    ['clean', 'clean'],
    ['error', 'error'],
    ['loading', 'loading'],
    ['blank', 'blank'],
  ] as const;

  it.each(expectations)('%s still is read as %s with confidence >= 0.7, in one cheap request', async (name, label) => {
    const t0 = Date.now();
    const [check] = await checkImages([{ png: still(name), name }], { client, model: DEFAULT_TRIAGE_MODEL, mode: 'fail', budget: budget() });
    lat[`triage ${name}`] = Date.now() - t0;
    expect(check).toMatchObject({ label });
    expect(check!.confidence).toBeGreaterThanOrEqual(0.7);
    expect(check!.action).toBe(label === 'clean' ? 'none' : 'fail');
    expect(check!.model).toBe(DEFAULT_TRIAGE_MODEL);
    expect(lat[`triage ${name}`]).toBeLessThan(10_000);
  });

  it('keeps an image request near 1.2k input tokens (the encoding guard stays well clear of the limit)', async () => {
    const before = client.stats.inputTokens;
    await checkImages([{ png: still('error'), name: 'error' }], { client, model: DEFAULT_TRIAGE_MODEL, mode: 'fail', budget: budget() });
    const tokens = client.stats.inputTokens - before;
    report.imageInputTokens = tokens;
    expect(tokens).toBeGreaterThan(300);
    expect(tokens).toBeLessThan(IMAGE_TOKEN_GUARD);
  });

  it('checks four stills concurrently (one request each) with all four verdicts right', async () => {
    const t0 = Date.now();
    const before = client.stats.requests;
    const checks = await checkImages(expectations.map(([name]) => ({ png: still(name), name })), {
      client,
      model: DEFAULT_TRIAGE_MODEL,
      mode: 'fail',
      budget: budget(),
    });
    lat['triage 4 concurrent (wall)'] = Date.now() - t0;
    expect(client.stats.requests - before).toBe(4);
    expect(checks.map((c) => c.label)).toEqual(['clean', 'error', 'loading', 'blank']);
    expect(lat['triage 4 concurrent (wall)']).toBeLessThan(15_000);
  });
});

live('Jev text decisions', () => {
  it('resolves the configured ids and answers a tiny noul (doctor\'s probe)', async () => {
    const probe = await probeModels(client, { triage: DEFAULT_TRIAGE_MODEL, text: DEFAULT_TEXT_MODEL }, 8000);
    report.probe = probe;
    lat['probe triage'] = probe.triage.ms;
    lat['probe text'] = probe.text.ms;
    expect(probe.triage).toMatchObject({ ok: true, resolved: DEFAULT_TRIAGE_MODEL });
    expect(probe.text.ok).toBe(true);
    expect(probe.text.resolved).toMatch(/^typesafe\/jev-1\.13/);
  });

  it('a noul ranks a visible change above one the diff cannot reach', async () => {
    const diff = ['--- a/src/components/StatusBadge.vue', '+++ b/src/components/StatusBadge.vue', '@@ -5,1 +5,1 @@', '-.badge-paid { background: #cfc; }', '+.badge-paid { background: #0a0; color: white; }'].join('\n');
    const state = {
      file: 'src/components/StatusBadge.vue',
      diff,
      routes: [
        { key: '/manage/invoices/:id', components: ['App.vue', 'pages/InvoiceDetail.vue', 'components/StatusBadge.vue'] },
        { key: '/about', components: ['App.vue', 'pages/About.vue'] },
      ],
    };
    const t0 = Date.now();
    const result = await client.decide({
      model: DEFAULT_TEXT_MODEL,
      state,
      questions: {
        r0: { type: 'noul', instructions: 'Does this change visibly affect what /manage/invoices/:id renders?', criteria: { true: 'the diff changes markup, styles or logic used by the page', false: 'the diff touches nothing the page renders' } },
        r1: { type: 'noul', instructions: 'Does this change visibly affect what /about renders?', criteria: { true: 'the diff changes markup, styles or logic used by the page', false: 'the diff touches nothing the page renders' } },
      },
    });
    lat['jev prune noul (2 questions)'] = Date.now() - t0;
    expect(result.ok).toBe(true);
    const affected = noulAnswer(result, 'r0')!.noul;
    const unaffected = noulAnswer(result, 'r1')!.noul;
    report.pruneNoul = { affected, unaffected };
    expect(affected).toBeGreaterThan(0.5);
    expect(unaffected).toBeLessThan(0.5);
  });
});

live('end to end through finish on the fixture app (real Chromium, real dev server)', () => {
  let h: Harness | undefined;
  const cleanup = async () => {
    await h?.cleanup();
    h = undefined;
  };
  const withKey = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, OPENROUTER_API_KEY: LIVE_KEY! });

  it('corpus: the DOM heuristics say clean but the pixels show an error banner; triage "fail" catches it', async () => {
    h = await createHarness({ config: { decisions: { enabled: true, triage: 'fail', verdict: false, captions: false } } });
    try {
      await h.start();
      const banner = `<script setup>
</script>
<template>
  <main>
    <h1>Reports</h1>
    <div style="margin:24px 0;padding:32px;background:#fdecea;border:2px solid #d93025;border-radius:8px;color:#8a1c14">
      <h2>Something went wrong</h2>
      <p>Error 500: we could not load your reports. Please try again later.</p>
      <button>Retry</button>
    </div>
  </main>
</template>
`;
      h.edit(REPORTS, () => banner);
      const event = await h.waitForFrame(forRoute(REPORTS_ROUTE, (e) => e.signals.text.includes('Something went wrong')), 15_000);
      expect(event.frame.status).toBe('clean'); // the DOM has nothing to complain about
      expect(event.frame.reasons).toEqual([]);
      h.commitAll('error banner');

      const t0 = Date.now();
      const result = await h.finish({ env: withKey(h.env) });
      lat['finish with triage fail (wall)'] = Date.now() - t0;
      expect(result.ok).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatch(/^\/reports looks error to the image check \((0\.[7-9]\d|1\.00)\)$/);
      expect(result.routes[0]).toMatchObject({ status: 'clean', imageCheck: { label: 'error', action: 'fail' } });
      expect(result.decisions).toMatchObject({ requests: 1, failed: 0 });
      expect(readBlock(result)).toContain('image check: error');
      report.corpus = { failures: result.failures, decisions: result.decisions };
    } finally {
      await cleanup();
    }
  });

  it('a normal page passes with every decision on: image check, claim verdict and captions', async () => {
    h = await createHarness({ config: { decisions: { enabled: true, triage: 'fail' } } });
    try {
      await h.start();
      h.edit(DETAIL, setHeading('Invoice (live)'));
      const event = await h.waitForFrame(forRoute(DETAIL_ROUTE, (e) => e.signals.text.includes('INV-001')), 15_000);
      expect(event.frame.status).toBe('clean');
      fs.writeFileSync(path.join(h.dirs.statusDir, 'claim.md'), '# Claim\n- The invoice page shows the invoice number INV-001\n- The invoice page shows a dark mode toggle\n');
      h.commitAll('live happy');

      const t0 = Date.now();
      const result = await h.finish({ env: withKey(h.env) });
      lat['finish with every decision (wall)'] = Date.now() - t0;
      expect(result.failures).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.routes[0]!.imageCheck).toMatchObject({ label: 'clean', action: 'none' });
      expect(result.routes[0]!.caption).toBeTruthy();

      // Target: image requests from triage plus at most 3 text requests.
      expect(result.decisions!.requests).toBe(3); // 1 image + 1 verdict + 1 captions on one headline
      expect(result.decisions!.failed).toBe(0);
      expect(result.decisions!.cost).toBeGreaterThan(0);

      const claim = result.claim!;
      expect(claim.criteria).toHaveLength(2);
      expect(claim.criteria[0]!.probability).toBeGreaterThan(0.5); // INV-001 is on the page
      expect(claim.criteria[1]!.probability).toBeLessThan(0.5); // there is no dark mode toggle
      const block = readBlock(result);
      expect(block).toContain('**Claim check (advisory)**');
      expect(block).toContain('Advisory — reviewer decides.');
      expect(block).toMatch(/\ndecisions: 3 requests, \d+ ms, \$0\.\d{6}\n$/);
      report.finish = { decisions: result.decisions, caption: result.routes[0]!.caption, claim: claim.criteria.map((c) => [c.text, c.result, c.probability]), verdict: claim.verdict, imageCheck: result.routes[0]!.imageCheck, notes: result.notes };
    } finally {
      await cleanup();
    }
  });
});
