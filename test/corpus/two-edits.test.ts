import { afterEach, beforeEach, expect, it } from 'vitest';
import { sidecarRoute } from '../../src/sidecar.js';
import { createHarness, type Harness } from '../integration/harness.js';
import { DATA, DETAIL, DETAIL_ROUTE, HOME, REPORTS, REPORTS_ROUTE, forRoute, setHeading } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await h.start();
});
afterEach(async () => {
  await h?.cleanup();
});

const BADGE = 'src/components/StatusBadge.vue'; // rendered by the invoice list and the invoice detail

it('two edits in a row: the first page keeps its earlier clean frame, and finish passes', async () => {
  h.edit(REPORTS, setHeading('Reports (first)'));
  const first = await h.waitForFrame(forRoute(REPORTS_ROUTE, (e) => e.signals.text.includes('Reports (first)')), 10_000);
  h.edit(HOME, setHeading('Home (second)'));
  const second = await h.waitForFrame(forRoute('/', (e) => e.signals.text.includes('Home (second)')), 10_000);
  expect(first.frame.treeHash).not.toBe(second.frame.treeHash);
  const tree = h.commitAll('two edits');
  expect(second.frame.treeHash).toBe(tree);

  const result = await h.finish();
  expect(result.failures).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.routes.map((r) => [r.route, r.carriedFrom])).toEqual([
    ['/', undefined],
    [REPORTS_ROUTE, first.frame.treeHash],
  ]);
  expect(result.routes.find((r) => r.route === REPORTS_ROUTE)!.frameId).toBe(first.frame.id);
  expect(result.notes.some((n) => n.startsWith(`${REPORTS_ROUTE} carried forward from tree ${first.frame.treeHash.slice(0, 8)}`))).toBe(true);
});

it('a later edit to a component the first page renders, without a recapture, fails it and names the file', async () => {
  h.edit(DETAIL, setHeading('Invoice (first)'));
  const first = await h.waitForFrame(forRoute(DETAIL_ROUTE, (e) => e.signals.text.includes('Invoice (first)')), 10_000);
  await h.stopWatch(); // the shared component changes while nothing is watching
  h.edit(BADGE, (s) => s.replace('class="badge"', 'class="badge" title="edited"'));
  h.commitAll('edit the shared badge');

  const result = await h.finish();
  expect(result.ok).toBe(false);
  expect(result.failures).toContain(
    `no frame at HEAD for ${DETAIL_ROUTE} (the last clean frame, at tree ${first.frame.treeHash.slice(0, 8)}, is stale: ${BADGE} (rendered in it) changed since)`,
  );
  expect(result.routes.find((r) => r.route === DETAIL_ROUTE)!.carriedFrom).toBeUndefined();
});

it('a backend change after the frame, without a recapture, fails it and names the backend file', async () => {
  h.edit(HOME, setHeading('Home (before the data change)'));
  const first = await h.waitForFrame(forRoute('/', (e) => e.signals.text.includes('before the data change')), 10_000);
  await h.stopWatch();
  h.edit(DATA, (s) => s.replace('"INV-001"', '"INV-001b"'));
  h.commitAll('home, then data');

  const result = await h.finish();
  expect(result.ok).toBe(false);
  expect(result.failures).toContain(
    `no frame at HEAD for / (the last clean frame, at tree ${first.frame.treeHash.slice(0, 8)}, is stale: ${DATA} (a backend file) changed since)`,
  );
});

it('a sidecar added after the route frames: the route frame is carried and the scenario passes with its own', async () => {
  const INTERACT = '/manage/interact';
  h.edit('src/pages/Interact.vue', (s) => s.replace('<h1>Interact</h1>', '<h1>Interact (edited)</h1>'));
  const page = await h.waitForFrame(forRoute(INTERACT, (e) => e.signals.text.includes('Interact (edited)')), 20_000);
  const file = h.writeSidecar('modal', `goto ${INTERACT}\nclick [data-test=open-modal]\nwait [data-test=confirm-modal]\nstill modal-open\n`);
  const still = await h.waitForFrame((e) => e.frame.route === sidecarRoute(file, 'modal-open'), 20_000);
  h.commitAll('page edit, then a sidecar');
  expect(still.frame.treeHash).not.toBe(page.frame.treeHash);

  const result = await h.finish();
  expect(result.failures).toEqual([]);
  expect(result.ok).toBe(true);
  const carried = result.routes.find((r) => r.route === INTERACT)!;
  expect(carried.carriedFrom).toBe(page.frame.treeHash);
  expect(result.routes.find((r) => r.route === sidecarRoute(file, 'modal-open'))!.carriedFrom).toBeUndefined();
});
