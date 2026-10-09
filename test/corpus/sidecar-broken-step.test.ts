import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sidecarRoute } from '../../src/sidecar.js';
import { createHarness, type Harness } from '../integration/harness.js';
import { readBlock } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await h.start();
});
afterEach(async () => {
  await h?.cleanup();
});

const INTERACT = '/manage/interact';

it('sidecar-broken-step: a wrong selector gives an error frame naming the line, and finish fails on it (not on an earlier clean state)', async () => {
  const file = h.writeSidecar(
    'refund',
    ['# the selector below does not exist', `goto ${INTERACT}`, 'click [data-test=invoice-refund]', 'still refund-modal'].join('\n'),
  );
  const broken = await h.waitForFrame((e) => e.frame.route === sidecarRoute(file, 'refund-modal'), 30_000);
  expect(broken.frame.status).toBe('error');
  expect(broken.frame.reasons).toEqual(['line 3 click [data-test=invoice-refund]: selector not found']);
  expect(broken.frame.steps).toEqual([
    { line: 2, text: `goto ${INTERACT}` },
    { line: 3, text: 'click [data-test=invoice-refund]' },
  ]);
  // The error frame shows where the scenario stood: the page itself, not a blank.
  expect(broken.signals.text).toContain('Interact');
  expect(fs.statSync(broken.pngPath).size).toBeGreaterThan(1000);

  const tree = h.commitAll('add a sidecar with a bad selector');
  expect(broken.frame.treeHash).toBe(tree);

  const result = await h.finish();
  expect(result.ok).toBe(false);
  expect(result.failures).toEqual([
    `sidecar ${file} still refund-modal: final frame is error: line 3 click [data-test=invoice-refund]: selector not found`,
  ]);
  expect(result.routes[0]).toMatchObject({ via: 'sidecar', status: 'error', route: sidecarRoute(file, 'refund-modal') });
  const block = readBlock(result);
  expect(block).toContain('selector not found');
  expect(block).toContain('sidecar refund / refund-modal');

  // Through the real CLI.
  const cli = await h.cli('finish');
  expect(cli.code).toBe(1);
  expect(cli.stderr).toContain('line 3 click [data-test=invoice-refund]: selector not found');
  expect(fs.existsSync(path.join(h.dirs.statusDir, 'proof-block.md'))).toBe(true);
});

it('sidecar-broken-step: fixing the selector and saving again turns the same finish green', async () => {
  const file = h.writeSidecar('refund', [`goto ${INTERACT}`, 'click [data-test=invoice-refund]', 'still refund-modal'].join('\n'));
  await h.waitForFrame((e) => e.frame.route === sidecarRoute(file, 'refund-modal') && e.frame.status === 'error', 30_000);

  h.writeSidecar('refund', [`goto ${INTERACT}`, 'click [data-test=open-modal]', 'wait [data-test=confirm-modal]', 'still refund-modal'].join('\n'));
  const fixed = await h.waitForFrame((e) => e.frame.route === sidecarRoute(file, 'refund-modal') && e.frame.status === 'clean', 30_000);
  expect(fixed.signals.text).toContain('Confirm refund');

  h.commitAll('fix the selector');
  const result = await h.finish();
  expect(result.failures).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.routes.map((r) => [r.route, r.status])).toEqual([[sidecarRoute(file, 'refund-modal'), 'clean']]);
});
