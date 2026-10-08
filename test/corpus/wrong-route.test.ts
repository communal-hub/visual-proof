import fs from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHarness, type Harness } from '../integration/harness.js';
import { HOME, REPORTS, REPORTS_ROUTE, forRoute, readBlock, setHeading } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await h.start();
});
afterEach(async () => {
  await h?.cleanup();
});

/** Capture an unrelated route, stop the watcher, then change a page that was never captured. */
async function setUp(): Promise<void> {
  h.edit(HOME, setHeading('Home (unrelated)'));
  await h.waitForFrame(forRoute('/'), 8000);
  h.edit(HOME, setHeading('Home')); // back to the base content, so only Reports differs from main
  await h.waitForFrame(forRoute('/', (e) => e.signals.text.includes('Home') && !e.signals.text.includes('unrelated')), 8000);
  await h.stopWatch();
  h.edit(REPORTS, setHeading('Reports (never captured)'));
  h.commitAll('edit reports with the watcher stopped');
}

it('wrong-route: a changed page that was never captured fails with "no frame at HEAD for /reports"', async () => {
  await setUp();
  const result = await h.finish();
  expect(result.ok).toBe(false);
  expect(result.failures).toEqual([`no frame at HEAD for ${REPORTS_ROUTE}`]);
  expect(readBlock(result)).toContain(`- no frame at HEAD for ${REPORTS_ROUTE}`);
  expect(result.hints.join('\n')).toContain('run visual-proof start'); // the watcher was stopped before the edit
  expect(fs.readdirSync(h.dirs.artifactDir)).toEqual([]);
});

it('wrong-route through the real CLI: exit 1, failure on stderr, proof block path on stdout', async () => {
  await setUp();
  const cli = await h.cli('finish');
  expect(cli.code).toBe(1);
  expect(cli.stderr).toContain(`no frame at HEAD for ${REPORTS_ROUTE}`);
  expect(fs.readFileSync(cli.stdout.trim(), 'utf8')).toContain('**Failures**');
});
