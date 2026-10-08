import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHarness, type Harness } from '../integration/harness.js';
import { REPORTS, REPORTS_ROUTE, readBlock, setHeading, sleep } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await h.start();
});
afterEach(async () => {
  await h?.cleanup();
});

it('stale-bundle: with the freshness marker gone the watcher refuses, and finish fails with "no frame at HEAD"', async () => {
  fs.rmSync(path.join(h.dir, '.visual-proof/hot'));
  const refused = h.waitForEvent<{ reason: string }>('refused', 8000);
  h.edit(REPORTS, setHeading('Reports (stale)'));
  expect((await refused).reason).toContain('freshness marker missing');
  await sleep(500);
  expect(h.frames).toEqual([]);
  h.commitAll('edit while the bundle was stale');

  const result = await h.finish();
  expect(result.ok).toBe(false);
  expect(result.failures).toEqual([`no frame at HEAD for ${REPORTS_ROUTE}`]);
  expect(readBlock(result)).toContain('**Failures**');

  const cli = await h.cli('finish');
  expect(cli.code).toBe(1);
  expect(cli.stderr).toContain('no frame at HEAD');
});
