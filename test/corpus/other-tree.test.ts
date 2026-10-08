import fs from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHarness, type Harness } from '../integration/harness.js';
import { REPORTS, REPORTS_ROUTE, forRoute } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await h.start();
});
afterEach(async () => {
  await h?.cleanup();
});

const EDITED = (s: string): string => s.replace('<h1>Reports</h1>', '<h1>Reports edited</h1>').replace('Total billed:', 'Billed:');

it('other-tree: an edit is captured, then partly reverted without a capture; the frame is from another tree', async () => {
  h.edit(REPORTS, EDITED);
  const captured = await h.waitForFrame(forRoute(REPORTS_ROUTE, (e) => e.signals.text.includes('Reports edited')), 8000);
  expect(captured.frame.status).toBe('clean');
  await h.stopWatch();

  // Revert the heading only (the unwatched save), so the file still differs from main.
  h.edit(REPORTS, (s) => s.replace('<h1>Reports edited</h1>', '<h1>Reports</h1>'));
  const tree = h.commitAll('revert part of the edit');
  expect(captured.frame.treeHash).not.toBe(tree);

  const result = await h.finish();
  expect(result.ok).toBe(false);
  expect(result.failures).toEqual([`no frame at HEAD for ${REPORTS_ROUTE}`]);
  // The clean frame from the other tree exists and is not substituted.
  expect(h.timeline().list().some((f) => f.id === captured.frame.id)).toBe(true);
  expect(fs.readdirSync(h.dirs.artifactDir)).toEqual([]);

  const cli = await h.cli('finish');
  expect(cli.code).toBe(1);
  expect(cli.stderr).toContain(`no frame at HEAD for ${REPORTS_ROUTE}`);
});

it('a full revert leaves nothing to prove: finish reports no screen changes (exit 0)', async () => {
  h.edit(REPORTS, EDITED);
  await h.waitForFrame(forRoute(REPORTS_ROUTE, (e) => e.signals.text.includes('Reports edited')), 8000);
  await h.stopWatch();
  h.git('checkout', '--', REPORTS);
  h.commitAll('revert everything');

  const result = await h.finish();
  expect(result).toMatchObject({ ok: true, noScreenChanges: true });
  const cli = await h.cli('finish');
  expect(cli.code).toBe(0);
  expect(cli.stdout).toBe(`${result.proofBlockPath}\n`);
  expect(cli.stderr).toContain('no screen changes');
});
