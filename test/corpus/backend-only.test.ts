import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../integration/harness.js';
import { DATA, DETAIL, DETAIL_ROUTE, forRoute, readBlock, setHeading } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await h.start();
  // Baseline: the page is captured and committed on `main`, so the work branch's only change is backend.
  h.git('checkout', '-q', 'main');
  h.edit(DETAIL, setHeading('Invoice (baseline)'));
  await h.waitForFrame(forRoute(DETAIL_ROUTE, (e) => e.signals.text.includes('baseline')), 8000);
  h.commitAll('baseline');
  h.git('checkout', '-q', '-B', 'work');
});
afterEach(async () => {
  await h?.cleanup();
});

describe('backend-only', () => {
  it('with the watcher running, the data edit is re-captured and finish passes with the new value', async () => {
    h.edit(DATA, (s) => s.replace('INV-001', 'INV-001-REVISED'));
    const event = await h.waitForFrame(forRoute(DETAIL_ROUTE, (e) => e.frame.trigger === 'backend'), 8000);
    expect(event.frame).toMatchObject({ status: 'clean', sourceFile: DATA });
    expect(event.signals.text).toContain('INV-001-REVISED');
    const tree = h.commitAll('backend data change');

    const result = await h.finish();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.routes.map((r) => [r.route, r.via, r.frameId])).toEqual([[DETAIL_ROUTE, 'backend', event.frame.id]]);
    // The headline is the backend frame, which shows the new value.
    const headline = h.timeline().latestAtTree(DETAIL_ROUTE, tree)!;
    expect(headline.id).toBe(event.frame.id);
    expect(readBlock(result)).toContain(`\`${DETAIL_ROUTE}\` · clean · tree ${tree.slice(0, 8)}`);

    expect((await h.cli('finish')).code).toBe(0);
  });

  it('with the watcher stopped before the data edit, finish fails with "no frame at HEAD"', async () => {
    await h.stopWatch();
    h.edit(DATA, (s) => s.replace('INV-001', 'INV-001-REVISED'));
    h.commitAll('backend data change, unwatched');

    const result = await h.finish();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      expect.stringMatching(new RegExp(`^no frame at HEAD for ${DETAIL_ROUTE} \\(the last clean frame, at tree [0-9a-f]{8}, is stale: ${DATA} \\(a backend file\\) changed since\\)$`)),
    ]);

    const cli = await h.cli('finish');
    expect(cli.code).toBe(1);
    expect(cli.stderr).toContain(`no frame at HEAD for ${DETAIL_ROUTE}`);
  });
});
