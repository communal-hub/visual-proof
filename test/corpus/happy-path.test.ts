import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHarness, type Harness } from '../integration/harness.js';
import { DETAIL, DETAIL_ROUTE, forRoute, readBlock, setHeading } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await h.start();
});
afterEach(async () => {
  await h?.cleanup();
});

it('happy path: edit, clean frame, commit, finish exits 0 with a valid proof block', async () => {
  h.edit(DETAIL, setHeading('Invoice (happy)'));
  const event = await h.waitForFrame(forRoute(DETAIL_ROUTE, (e) => e.signals.text.includes('Invoice (happy)')), 8000);
  expect(event.frame.status).toBe('clean');
  const tree = h.commitAll('happy path');
  expect(event.frame.treeHash).toBe(tree);

  // Through the real CLI.
  const cli = await h.cli('finish');
  expect(cli.stderr).toBe('');
  expect(cli.code).toBe(0);
  const blockPath = path.join(h.dirs.statusDir, 'proof-block.md');
  expect(cli.stdout).toBe(`${blockPath}\n`);

  const block = fs.readFileSync(blockPath, 'utf8');
  const short = tree.slice(0, 8);
  expect(block.match(/<img /g)).toHaveLength(1);
  const artifact = path.join(h.dirs.artifactDir, `manage-invoices-1-${short}.png`);
  expect(block).toContain(`<img src="${artifact}" alt="${DETAIL_ROUTE}">`);
  expect(block).toContain(`\`${DETAIL_ROUTE}\` · clean · tree ${short}`);
  expect(block.split('\n')[0]).toBe(`**Visual proof** · tree \`${short}\` · session \`${h.watch!.sessionId}\``);
  expect(block).not.toContain('Failures');

  // The artifact is the headline frame's PNG, byte for byte.
  expect(fs.readdirSync(h.dirs.artifactDir)).toEqual([path.basename(artifact)]);
  expect(fs.readFileSync(artifact).equals(fs.readFileSync(event.pngPath))).toBe(true);
  expect(fs.readFileSync(artifact).subarray(1, 4).toString()).toBe('PNG');
  expect(h.git('rev-parse', 'HEAD^{tree}')).toBe(tree);

  // And the module API agrees.
  const result = await h.finish();
  expect(result).toMatchObject({ ok: true, failures: [], treeHash: tree });
  expect(result.routes.map((r) => r.route)).toEqual([DETAIL_ROUTE]);
});
