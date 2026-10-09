import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { readDom } from '../../src/browser.js';
import { checkClaim, type ClaimPage } from '../../src/decisions/claim.js';
import { DecisionsClient } from '../../src/decisions/client.js';
import { DecisionBudget } from '../../src/decisions/budget.js';
import { DEFAULT_TRIAGE_MODEL } from '../../src/decisions/config.js';
import { renderClaimSection } from '../../src/decisions/finish.js';
import { checkImages } from '../../src/decisions/image-check.js';
import { LIVE_KEY } from '../live.js';

describe.skipIf(!LIVE_KEY)('Luna claim evidence regressions (real pixels and real API)', () => {
  it('sees teleported warnings, icons and tall page content, and rejects claims contradicted by an empty state', async () => {
    const dir = process.env.VP_CLAIM_PROOF_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vp-claim-proof-'));
    fs.mkdirSync(dir, { recursive: true });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pages: ClaimPage[] = [];
    const fixtures = [
      ['archive-modal', `<div id="app"><h1>Promotion codes</h1><p>Summer discount</p></div>
        <div role="dialog" aria-modal="true" class="modal show" style="position:fixed;left:320px;top:180px;width:560px;padding:32px;background:white;box-shadow:0 0 0 2000px #0006">
          <h2>Archive discount code?</h2><p>This will also archive 3 promotion codes.</p><button>Cancel</button><button>Archive</button></div>`],
      ['icon-controls', `<div id="app"><h1>Member profile</h1><div style="display:flex;gap:20px;align-items:center"><span style="padding:10px 24px;background:#15803d;color:white;border-radius:20px">Active</span>
        <button aria-label="Upload photo" title="Upload photo" style="width:56px;height:48px"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="black" stroke-width="2"><path d="M4 8h4l2-3h4l2 3h4v12H4z"/><circle cx="12" cy="13" r="4"/></svg></button></div></div>`],
      ['tall-invoice', `<div id="app" style="height:2404px;position:relative"><h1>Invoice</h1><p>Line items</p>
        <table style="width:100%;border-collapse:collapse"><thead><tr><th align="left">Description</th><th align="right">Amount</th></tr></thead><tbody>
          ${Array.from({ length: 38 }, (_, i) => `<tr style="height:52px;border-bottom:1px solid #cbd5e1"><td>Community membership item ${i + 1}</td><td align="right">$14.00</td></tr>`).join('')}
        </tbody></table><div style="position:absolute;top:2280px"><h2>Invoice total: $535.75</h2></div></div>`],
      ['empty-scans', `<div id="app"><h1>Scanned members</h1><div style="border:1px solid #ccc;padding:48px;text-align:center;margin-top:40px"><h2>No one currently scanned in</h2><p>Members will appear here after check-in.</p></div></div>`],
    ] as const;
    try {
      for (const [name, html] of fixtures) {
        await page.setContent(`<style>body{font:18px system-ui;margin:8px;background:#f8fafc;color:#172033}#app{padding:32px}button{font:inherit;margin-right:12px;padding:8px 16px}</style>${html}`);
        const dom = await readDom(page, '#app', []);
        const png = path.join(dir, `${name}.png`);
        await page.screenshot({ path: png, fullPage: true });
        pages.push({ route: `/${name}`, png, visibleText: dom!.fullText, renderedFiles: null });
      }
    } finally { await browser.close(); }

    const client = new DecisionsClient({ apiKey: LIVE_KEY!, timeoutMs: 15_000 });
    const budget = new DecisionBudget(20_000);
    const claim = [
      '- The archive-modal page warns that archiving will also archive 3 promotion codes.',
      '- The icon-controls page shows an icon-only camera button for uploading a photo.',
      '- The icon-controls page shows a green Active badge.',
      '- The tall-invoice page visibly shows Invoice total: $535.75 at the bottom.',
      '- The empty-scans page lists currently scanned members with a remove button on each row.',
      '- The empty-scans page shows at least one scanned member.',
    ].join('\n');
    try {
      const [report, checks] = await Promise.all([
        checkClaim({ source: 'regression-claim.md', claim, pages, role: 'anonymous' }, { client, model: DEFAULT_TRIAGE_MODEL, budget }),
        checkImages([pages[2]!, pages[3]!].map((p) => ({ png: p.png, name: p.route })), { client, model: DEFAULT_TRIAGE_MODEL, mode: 'fail', budget }),
      ]);
      fs.writeFileSync(path.join(dir, 'report.json'), `${JSON.stringify({ claim: report, imageChecks: checks, stats: client.stats, budgetMs: 20_000, elapsedMs: budget.elapsedMs() }, null, 2)}\n`);
      fs.writeFileSync(path.join(dir, 'claim-check.md'), `${renderClaimSection(report).join('\n')}\n`);
      console.log(`Claim proof: ${report.criteria.map((c) => `${c.result} (${c.probability?.toFixed(2)})`).join(', ')}; ${client.stats.requests} requests; $${client.stats.cost.toFixed(6)}; ${budget.elapsedMs()} ms; ${dir}`);
      expect(report.criteria.map((c) => c.result)).toEqual(['satisfied', 'satisfied', 'satisfied', 'satisfied', 'not visible', 'not visible']);
      expect(report.criteria[4]!.reason).toContain('empty state contradicts');
      expect(report.criteria[5]!.reason).toContain('empty state contradicts');
      expect(report.verdict).toBe('partial');
      expect(checks.map((c) => c.label)).toEqual(['clean', 'clean']);
      expect(client.stats.failed).toBe(0);
    } finally { budget.dispose(); }
  });
});
