import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHarness, type Harness } from '../integration/harness.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h?.cleanup();
});

it('no-screen-changes: a commit that only touches a non-screen file exits 0 with "no screen changes"', async () => {
  fs.writeFileSync(path.join(h.dir, 'README.md'), '# docs only\n');
  h.commitAll('docs');

  const result = await h.finish();
  expect(result).toMatchObject({ ok: true, noScreenChanges: true, failures: [], routes: [] });
  expect(fs.readFileSync(result.proofBlockPath, 'utf8')).not.toContain('<img');
  expect(fs.readdirSync(h.dirs.artifactDir)).toEqual([]);

  const cli = await h.cli('finish');
  expect(cli).toEqual({ code: 0, stdout: 'no screen changes\n', stderr: '' });
});
