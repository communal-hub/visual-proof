import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHarness, type Harness } from '../integration/harness.js';
import { REPORTS, REPORTS_ROUTE, setHeading, sleep } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await h.start();
});
afterEach(async () => {
  await h?.cleanup();
});

it('hook mode: a failing finish exits 0 with one stdout line, and records the failure next to the live daemon status', async () => {
  // Stale bundle: the watcher stays up (state ready) but refuses to capture.
  fs.rmSync(path.join(h.dir, '.visual-proof/hot'));
  const refused = h.waitForEvent('refused', 8000);
  h.edit(REPORTS, setHeading('Reports (hook)'));
  await refused;
  h.commitAll('edit while stale');

  const cli = await h.cli('finish', '--hook');
  const blockPath = path.join(h.dirs.statusDir, 'proof-block.md');
  expect(cli.code).toBe(0);
  expect(cli.stderr).toBe('');
  expect(cli.stdout).toBe(`visual-proof: 1 failure, see ${blockPath}\n`);

  const statusFile = path.join(h.dirs.statusDir, 'status.json');
  const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  expect(status).toMatchObject({ state: 'ready', trigger: 'fs-watch', sessionId: h.watch!.sessionId });
  expect(status.lastFinish).toMatchObject({ ok: false, failures: [`no frame at HEAD for ${REPORTS_ROUTE}`] });
  expect(Date.parse(status.lastFinish.at)).not.toBeNaN();
  expect(fs.readFileSync(path.join(h.dirs.statusDir, 'watcher.log'), 'utf8')).toMatch(
    new RegExp(`^\\S+ finish failure: no frame at HEAD for ${REPORTS_ROUTE}$`, 'm'),
  );
  expect(fs.readFileSync(blockPath, 'utf8')).toContain('**Failures**');

  // The watcher's own later status writes keep lastFinish.
  await h.stopWatch();
  await sleep(100);
  expect(JSON.parse(fs.readFileSync(statusFile, 'utf8'))).toMatchObject({ state: 'stopped', lastFinish: { ok: false } });
});
