import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHarness, type Harness } from '../integration/harness.js';
import { DETAIL, DETAIL_ROUTE, breakSetup, forRoute, readBlock, setHeading } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await h.start();
});
afterEach(async () => {
  await h?.cleanup();
});

it('broken-final-save: a good edit then a throwing edit fails with "final frame is error", not the earlier clean frame', async () => {
  h.edit(DETAIL, setHeading('Invoice (good)'));
  const good = await h.waitForFrame(forRoute(DETAIL_ROUTE, (e) => e.signals.text.includes('Invoice (good)')), 8000);
  expect(good.frame.status).toBe('clean');

  h.edit(DETAIL, breakSetup);
  const broken = await h.waitForFrame(forRoute(DETAIL_ROUTE, (e) => e.frame.status === 'error'), 8000);
  expect(broken.frame.reasons.join('\n')).toContain('corpus: broken final save');
  expect(broken.frame.treeHash).not.toBe(good.frame.treeHash);

  const tree = h.commitAll('good edit, then a breaking one');
  expect(broken.frame.treeHash).toBe(tree);

  const result = await h.finish();
  expect(result.ok).toBe(false);
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]).toContain(`${DETAIL_ROUTE} final frame is error`);
  expect(result.failures[0]).toContain('corpus: broken final save');
  expect(result.routes[0]).toMatchObject({ route: DETAIL_ROUTE, status: 'error', frameId: broken.frame.id });

  // The clean frame is still in the timeline, but it was not used as the headline.
  expect(h.timeline().list().some((f) => f.id === good.frame.id && f.status === 'clean')).toBe(true);
  const artifact = path.join(h.dirs.artifactDir, `manage-invoices-1-${tree.slice(0, 8)}.png`);
  expect(fs.readdirSync(h.dirs.artifactDir)).toEqual([path.basename(artifact)]);
  expect(fs.readFileSync(artifact).equals(fs.readFileSync(broken.pngPath))).toBe(true);
  expect(fs.readFileSync(artifact).equals(fs.readFileSync(good.pngPath))).toBe(false);
  expect(readBlock(result)).toContain(`\`${DETAIL_ROUTE}\` · error · tree ${tree.slice(0, 8)}`);

  // Through the real CLI too.
  const cli = await h.cli('finish');
  expect(cli.code).toBe(1);
  expect(cli.stderr).toContain(`${DETAIL_ROUTE} final frame is error`);
});
