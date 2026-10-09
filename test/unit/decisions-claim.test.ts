import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DecisionBudget } from '../../src/decisions/budget.js';
import { checkClaim, claimPath, classify, overallVerdict, readClaim, splitCriteria } from '../../src/decisions/claim.js';
import { CLEAN_PNG, FakeClient, choice, hang, noul, okResult } from './decisions-helpers.js';
import { tmpDir } from './helpers.js';

const PAGES = [
  { png: CLEAN_PNG, route: '/reports', visibleText: 'Reports Total billed: 535.75', renderedFiles: ['src/pages/Reports.vue'] },
  { png: CLEAN_PNG, route: '/manage/invoices/1', visibleText: 'Invoice INV-001 paid', renderedFiles: null },
];
const opts = (client: FakeClient, budgetMs = 5000) => ({ client, model: 'luna', budget: new DecisionBudget(budgetMs) });

describe('splitCriteria', () => {
  it('takes bullet and numbered lines as criteria', () => {
    expect(splitCriteria('Intro text\n- first thing\n* second thing\n+ third\n1. numbered\n2) also numbered\nnot a bullet')).toEqual([
      'first thing',
      'second thing',
      'third',
      'numbered',
      'also numbered',
    ]);
  });
  it('uses the whole text as one criterion when there are no bullets', () => {
    expect(splitCriteria('The reports page\nshows a total.\n')).toEqual(['The reports page shows a total.']);
    expect(splitCriteria('   \n')).toEqual([]);
  });
  it('caps the number and the length of criteria', () => {
    const many = Array.from({ length: 30 }, (_, i) => `- c${i}`).join('\n');
    expect(splitCriteria(many)).toHaveLength(12);
    expect(splitCriteria(`- ${'x'.repeat(500)}`)[0]).toHaveLength(303);
  });
});

describe('thresholds', () => {
  it.each([
    [1, 'satisfied'],
    [0.7, 'satisfied'],
    [0.69, 'partial'],
    [0.3, 'partial'],
    [0.29, 'not visible'],
    [0, 'not visible'],
  ] as const)('%s -> %s', (p, result) => expect(classify(p)).toBe(result));

  it('derives the overall verdict in code', () => {
    expect(overallVerdict(['satisfied', 'satisfied'])).toBe('satisfied');
    expect(overallVerdict(['satisfied', 'not visible'])).toBe('partial');
    expect(overallVerdict(['partial', 'partial'])).toBe('partial');
    expect(overallVerdict(['not visible', 'not visible'])).toBe('not visible');
  });
});

describe('claimPath / readClaim', () => {
  it('defaults to <statusDir>/claim.md and resolves claimFile against the repo', () => {
    expect(claimPath(undefined, '/repo', '/status')).toBe(path.join('/status', 'claim.md'));
    expect(claimPath('docs/claim.md', '/repo', '/status')).toBe(path.resolve('/repo', 'docs/claim.md'));
    const dir = tmpDir('vp-claim-');
    expect(readClaim(path.join(dir, 'none.md'))).toEqual({ missing: true });
    fs.writeFileSync(path.join(dir, 'c.md'), '  \n');
    expect(readClaim(path.join(dir, 'c.md'))).toEqual({ error: 'the claim file is empty' });
    fs.writeFileSync(path.join(dir, 'c.md'), '- a\n');
    expect(readClaim(path.join(dir, 'c.md'))).toEqual({ text: '- a\n' });
  });
});

describe('checkClaim', () => {
  it('sends one request with a noul per criterion over the pages, and classifies each answer', async () => {
    const client = new FakeClient(() => okResult({ c0: noul(0.98), c1: noul(0.5), c2: noul(0.02) }, { model: 'typesafe/jev-1.13-20260917' }));
    const report = await checkClaim(
      { source: 'docs/claim.md', claim: '- The reports page shows a total\n- The badge is green\n- A dark mode toggle exists', pages: PAGES, role: 'admin@example.test' },
      opts(client),
    );
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0]!;
    expect(call.model).toBe('luna');
    const parts = call.state as Array<{ type?: string; image_url?: { url: string } }>;
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(2);
    expect(parts.find((p) => p.type === 'image_url')!.image_url!.url).toBe(`data:image/png;base64,${fs.readFileSync(CLEAN_PNG).toString('base64')}`);
    const state = JSON.parse((call.state as string[])[0]!) as { claim: string[]; pages: Array<{ route: string; visibleText: string; renderedFiles: string[] | null }> };
    expect(state.claim).toEqual(['The reports page shows a total', 'The badge is green', 'A dark mode toggle exists']);
    expect(state.pages.map((p) => p.route)).toEqual(['/reports', '/manage/invoices/1']);
    expect(state.pages[0]!.visibleText).toBe('Reports Total billed: 535.75');
    expect(state.pages[0]!.renderedFiles).toEqual(['src/pages/Reports.vue']);
    expect(Object.values(call.questions).map((q) => q.type)).toEqual(['noul', 'choice', 'noul', 'choice', 'noul', 'choice']);
    expect(call.questions.c1!.instructions).toContain('The badge is green');

    expect(report.criteria.map((c) => [c.result, c.probability])).toEqual([
      ['satisfied', 0.98],
      ['partial', 0.5],
      ['not visible', 0.02],
    ]);
    expect(report).toMatchObject({ verdict: 'partial', source: 'docs/claim.md', routes: ['/reports', '/manage/invoices/1'], role: 'admin@example.test', model: 'typesafe/jev-1.13-20260917' });
  });

  it('keeps the model\'s window in mind: page text is trimmed per page', async () => {
    const client = new FakeClient(() => okResult({ c0: noul(0.9) }));
    const big = Array.from({ length: 60 }, (_, i) => ({ png: CLEAN_PNG, route: `/r${i}`, visibleText: '漢😀'.repeat(8192), renderedFiles: null }));
    await checkClaim({ source: 's', claim: 'one', pages: big, role: 'anonymous' }, opts(client));
    const pages = (JSON.parse((client.calls[0]!.state as string[])[0]!) as { pages: Array<{ visibleText: string }> }).pages;
    const total = pages.reduce((n, p) => n + Buffer.byteLength(p.visibleText), 0);
    expect(total).toBeLessThanOrEqual(24_000);
    expect(pages.every((p) => p.visibleText.length < 8192)).toBe(true);
  });

  it('reports a contradictory empty state as not visible with a reason, while a claim about the empty state can pass', async () => {
    const client = new FakeClient((req) => {
      expect(req.questions.c0!.instructions).toContain('empty state');
      expect(req.questions.reason0!.instructions).toContain('no other page');
      return okResult({ c0: noul(0.85), reason0: choice('empty_state', 0.95), c1: noul(0.95), reason1: choice('visible', 1) });
    });
    const report = await checkClaim({ source: 'claim.md', claim: '- Scanned members are listed with a remove icon\n- The page shows the empty state', pages: [{ ...PAGES[0]!, visibleText: 'No one currently scanned in' }], role: 'r' }, opts(client));
    expect(report.criteria[0]).toMatchObject({ result: 'not visible', probability: 0.29, reason: expect.stringContaining('empty state contradicts') });
    expect(report.criteria[1]).toMatchObject({ result: 'satisfied', probability: 0.95 });
    expect(report.verdict).toBe('partial');
  });

  it('does not fall back to text when a screenshot cannot be read', async () => {
    const client = new FakeClient(() => okResult({ c0: noul(0.99) }));
    const report = await checkClaim({ source: 's', claim: '- a', pages: [{ ...PAGES[0]!, png: '/missing.png' }], role: 'r' }, opts(client));
    expect(report).toMatchObject({ verdict: 'unknown', note: expect.stringContaining('cannot read screenshot') });
    expect(client.calls).toHaveLength(0);
  });

  it('a criterion without an answer stops the overall verdict from claiming "satisfied"', async () => {
    const client = new FakeClient(() => okResult({ c0: noul(0.99) }));
    const report = await checkClaim({ source: 's', claim: '- a\n- b', pages: PAGES, role: 'anonymous' }, opts(client));
    expect(report.criteria[1]).toMatchObject({ result: 'unknown', probability: null });
    expect(report.verdict).toBe('partial');
    expect(report.note).toBe('1 criterion(s) got no answer');
  });

  it('never throws: a failed request, an exhausted budget, no pages or no text are reports with a note', async () => {
    const down = new FakeClient(() => ({ ok: false, kind: 'http', status: 500, error: 'HTTP 500: boom', ms: 1 }));
    expect(await checkClaim({ source: 's', claim: '- a', pages: PAGES, role: 'r' }, opts(down))).toMatchObject({ verdict: 'unknown', note: 'claim check failed: HTTP 500: boom' });

    const t0 = Date.now();
    const cut = await checkClaim({ source: 's', claim: '- a', pages: PAGES, role: 'r' }, opts(new FakeClient(hang), 40));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(cut).toMatchObject({ verdict: 'unknown', note: 'skipped: decision budget exhausted' });

    expect((await checkClaim({ source: 's', claim: '- a', pages: [], role: 'r' }, opts(down))).note).toBe('no clean frames to check the claim against');
    expect((await checkClaim({ source: 's', claim: ' ', pages: PAGES, role: 'r' }, opts(down))).note).toBe('the claim has no text');
  });
});
