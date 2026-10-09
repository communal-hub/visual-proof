import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA, DETAIL, forRoute, setHeading, sleep } from '../corpus/helpers.js';
import { createHarness, harnessFiles, type Harness } from './harness.js';

const INVOICE = '/manage/invoices/:id';
const PROJECT = '/manage/projects/:id';
const TEAM = '/manage/clubs/:clubId/teams/:teamId';
const PROJECT_DETAIL = 'src/pages/ProjectDetail.vue';
const TEAM_DETAIL = 'src/pages/TeamDetail.vue';

// No routeParams: every param route has to come from a session param or from link discovery.
const NO_PARAMS = { routeParams: {} };

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const readStatus = (harness: Harness): Record<string, any> => JSON.parse(fs.readFileSync(harnessFiles(harness).status, 'utf8'));
const readJson = (file: string): Record<string, any> => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('link discovery against the fixture', () => {
  it('finds an id on the parent list page with nothing configured, captures it and finish proves it', async () => {
    h = await createHarness({ config: NO_PARAMS });
    await h.start();

    h.edit(DETAIL, setHeading('Found by links'));
    // The list links "New invoice" (/manage/invoices/new, a static sibling) and another site before its first invoice.
    const event = await h.waitForFrame(forRoute('/manage/invoices/1', (e) => e.signals.text.includes('Found by links')), 20_000);
    expect(event.frame).toMatchObject({ routeKey: INVOICE, status: 'clean', trigger: 'screen', paramsFrom: 'discovered', paramsFoundOn: '/manage/invoices' });
    expect(event.frame.timing).toMatchObject({ settleMs: expect.any(Number), screenshotMs: expect.any(Number), discoveryMs: expect.any(Number) });
    expect(event.frame.timing!.discoveryMs).toBeGreaterThan(0);

    expect(readStatus(h).paramDiscovery[INVOICE]).toMatchObject({ path: '/manage/invoices/1', foundOn: '/manage/invoices' });
    const cache = readJson(harnessFiles(h).paramDiscovery);
    expect(cache).toMatchObject({ sessionId: h.watch!.sessionId, routes: { [INVOICE]: { path: '/manage/invoices/1', foundOn: '/manage/invoices' } } });

    h.commitAll('detail heading');
    const result = await h.finish();
    expect(result).toMatchObject({ ok: true, failures: [], unfilled: [] });
    expect(result.routes.map((r) => [r.routeKey, r.route, r.status, r.paramsFrom, r.paramsFoundOn])).toEqual([
      [INVOICE, '/manage/invoices/1', 'clean', 'discovered', '/manage/invoices'],
    ]);
    expect(result.seedCandidates).toEqual([
      { routeKey: INVOICE, route: '/manage/invoices/1', params: { id: '1' }, paramsFrom: 'discovered', foundOn: '/manage/invoices' },
    ]);
    expect(result.notes).toContain('/manage/invoices/1: params found by link discovery on /manage/invoices');
    expect(result.proofBlock).toContain('params found by link discovery on /manage/invoices');
  });

  it('discovers a nested route through its parent, which is discovered in turn', async () => {
    h = await createHarness({ config: NO_PARAMS });
    await h.start();

    h.edit(TEAM_DETAIL, setHeading('Nested'));
    const event = await h.waitForFrame(forRoute('/manage/clubs/1/teams/10', (e) => e.signals.text.includes('U12')), 30_000);
    expect(event.frame).toMatchObject({ routeKey: TEAM, status: 'clean', paramsFrom: 'discovered', paramsFoundOn: '/manage/clubs/1/teams' });

    const status = readStatus(h);
    expect(status.paramDiscovery[TEAM]).toMatchObject({ path: '/manage/clubs/1/teams/10', foundOn: '/manage/clubs/1/teams' });
    expect(status.paramDiscovery['/manage/clubs/:clubId/teams']).toMatchObject({ path: '/manage/clubs/1/teams', foundOn: '/manage/clubs' });
  });

  it('falls through to discovery when a configured paramSources entry fails', async () => {
    h = await createHarness({ config: { ...NO_PARAMS, paramSources: { [INVOICE]: { url: '/api/invoices/99', pick: 'id' } } } });
    await h.start();
    h.edit(DETAIL, setHeading('Source fails'));
    const event = await h.waitForFrame(forRoute('/manage/invoices/1', (e) => e.signals.text.includes('Source fails')), 20_000);
    expect(event.frame).toMatchObject({ paramsFrom: 'discovered' });
    expect(readStatus(h).paramSources[INVOICE].error).toBe('paramSources /api/invoices/99 failed: HTTP 404');
  });

  it('with paramDiscovery "off" the route stays unfilled', async () => {
    h = await createHarness({ config: { ...NO_PARAMS, paramDiscovery: 'off' } });
    await h.start();
    h.edit(DETAIL, setHeading('Discovery off'));
    await h.waitForEvent('batch', 15_000);
    expect(h.frames).toEqual([]);
    h.commitAll('off');
    const result = await h.finish();
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('discovery: off (paramDiscovery: "off")');
    expect(result.unfilled[0]!.tiers.at(-1)).toMatchObject({ tier: 'discovery', tried: false });
  });

  it('a backend change drops the discovery cache, so a re-seeded database gives the new id', async () => {
    h = await createHarness({ config: NO_PARAMS });
    await h.start();
    h.edit(DETAIL, setHeading('Before reseed'));
    await h.waitForFrame(forRoute('/manage/invoices/1', (e) => e.signals.text.includes('Before reseed')), 20_000);
    expect(readJson(harnessFiles(h).paramDiscovery).routes[INVOICE].path).toBe('/manage/invoices/1');
    await sleep(300);

    // A re-seed: invoice 3 now comes first on the list.
    const from = h.frames.length;
    h.edit(DATA, (source) => {
      const data = JSON.parse(source) as { invoices: Array<{ id: number }> };
      data.invoices.reverse();
      return JSON.stringify(data, null, 2);
    });
    const event = await h.waitForFrame(forRoute('/manage/invoices/3'), 20_000, { from });
    expect(event.frame).toMatchObject({ trigger: 'backend', status: 'clean', routeKey: INVOICE, paramsFrom: 'discovered' });
    expect(event.signals.text).toContain('INV-003');
    expect(readJson(harnessFiles(h).paramDiscovery).routes[INVOICE].path).toBe('/manage/invoices/3');

    h.commitAll('reseed');
    const result = await h.finish();
    expect(result).toMatchObject({ ok: true, failures: [] });
    expect(result.routes.map((r) => r.route)).toContain('/manage/invoices/3');
  });
});

describe('a list that navigates by click handler (no hrefs)', () => {
  it('stays unfilled; finish fails with the exact params set command; params set captures it and finish passes', async () => {
    h = await createHarness({ config: NO_PARAMS });
    await h.start();

    h.edit(PROJECT_DETAIL, setHeading('Click only'));
    await h.waitForEvent('batch', 20_000);
    expect(h.frames).toEqual([]);
    expect(readStatus(h).paramDiscovery[PROJECT].error).toBe(`no link matching ${PROJECT} on /manage/projects`);
    h.commitAll('project heading');

    const failed = await h.finish();
    expect(failed.ok).toBe(false);
    expect(failed.failures).toEqual([
      `cannot capture ${PROJECT}: params unfilled. Tried: session: none set; routeParams: no entry; routeParamsFile: not configured; paramSources: not configured; discovery: no link matching ${PROJECT} on /manage/projects. Fix: npx visual-proof params set '${PROJECT}' id=<value>. If no record exists, create one first (e.g. with the app's factories or seeders) and use its id.`,
    ]);
    expect(failed.unfilled).toHaveLength(1);
    expect(failed.unfilled[0]).toMatchObject({
      routeKey: PROJECT,
      params: ['id'],
      command: `npx visual-proof params set '${PROJECT}' id=<value>`,
      tiers: [
        { tier: 'session', tried: true, reason: 'none set' },
        { tier: 'routeParams', tried: true, reason: 'no entry' },
        { tier: 'routeParamsFile', tried: false, reason: 'not configured' },
        { tier: 'paramSources', tried: false, reason: 'not configured' },
        { tier: 'discovery', tried: true, reason: `no link matching ${PROJECT} on /manage/projects` },
      ],
    });
    const cli = await h.cli('finish');
    expect(cli.code).toBe(1);
    expect(cli.stderr).toContain("npx visual-proof params set '/manage/projects/:id' id=<value>");

    // The agent creates (here: knows of) a record and tells visual-proof its id; the watcher captures at once.
    const set = await h.cli('params', 'set', PROJECT, 'id=7');
    expect(set.code).toBe(0);
    expect(set.stdout).toContain(`session params set: ${PROJECT} -> /manage/projects/7`);
    expect(set.stdout).toMatch(/captured \/manage\/projects\/7: clean \(frame f-\d+, tree [0-9a-f]{8}\)/);
    const frame = h.frames.at(-1)!.frame;
    expect(frame).toMatchObject({ route: '/manage/projects/7', routeKey: PROJECT, status: 'clean', trigger: 'params', paramsFrom: 'session' });
    expect(frame.treeHash).toBe(h.git('rev-parse', 'HEAD^{tree}')); // captured at the current tree

    const fixed = await h.finish();
    expect(fixed).toMatchObject({ ok: true, failures: [], unfilled: [] });
    expect(fixed.routes.map((r) => [r.route, r.paramsFrom])).toEqual([['/manage/projects/7', 'session']]);
    expect(fixed.seedCandidates).toEqual([{ routeKey: PROJECT, route: '/manage/projects/7', params: { id: '7' }, paramsFrom: 'session' }]);
    expect(fixed.notes).toContain('/manage/projects/7: params set with visual-proof params set');
  });
});

describe('params set against a running watcher', () => {
  it('captures a route that was never part of the session changes', async () => {
    h = await createHarness({ config: NO_PARAMS });
    await h.start();
    expect(h.frames).toEqual([]);

    const set = await h.cli('params', 'set', '/manage/clubs/:clubId/teams', 'clubId=2');
    expect(set.code).toBe(0);
    expect(set.stdout).toMatch(/captured \/manage\/clubs\/2\/teams: clean/);
    const event = h.frames.at(-1)!;
    expect(event.frame).toMatchObject({ route: '/manage/clubs/2/teams', trigger: 'params', paramsFrom: 'session' });
    expect(event.signals.text).toContain('U10');

    const list = await h.cli('params', 'list', '--json');
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({
      session: [{ routeKey: '/manage/clubs/:clubId/teams', path: '/manage/clubs/2/teams', params: { clubId: '2' } }],
      seedCandidates: [{ routeKey: '/manage/clubs/:clubId/teams', params: { clubId: '2' }, paramsFrom: 'session' }],
    });
  });

  it('session params outrank routeParams, and clear falls back to them', async () => {
    h = await createHarness(); // routeParams: /manage/invoices/:id -> /manage/invoices/1
    await h.start();

    const set = await h.cli('params', 'set', INVOICE, 'id=2');
    expect(set.code).toBe(0);
    expect(h.frames.at(-1)!.frame).toMatchObject({ route: '/manage/invoices/2', paramsFrom: 'session' });

    h.edit(DETAIL, setHeading('Session wins'));
    const event = await h.waitForFrame(forRoute('/manage/invoices/2', (e) => e.signals.text.includes('Session wins')), 15_000);
    expect(event.frame.paramsFrom).toBe('session');

    expect((await h.cli('params', 'clear', INVOICE)).code).toBe(0);
    h.edit(DETAIL, setHeading('Config again'));
    const again = await h.waitForFrame(forRoute('/manage/invoices/1', (e) => e.signals.text.includes('Config again')), 15_000);
    expect(again.frame.paramsFrom).toBe('config');
  });

  it('exits 2 for an unknown route key (with the closest keys) and for missing, extra or ill-fitting params', async () => {
    h = await createHarness({ config: NO_PARAMS });
    const unknown = await h.cli('params', 'set', '/manage/invoice/:id', 'id=1');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('closest route keys: /manage/invoices/:id');

    const missing = await h.cli('params', 'set', TEAM, 'clubId=1');
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('needs teamId');

    const extra = await h.cli('params', 'set', INVOICE, 'id=1', 'slug=x');
    expect(extra.code).toBe(2);
    expect(extra.stderr).toContain('has no param slug');
    expect(fs.existsSync(harnessFiles(h).sessionParams)).toBe(false);
  });

  it('without a running watcher it stores the params and says nothing was captured', async () => {
    h = await createHarness({ config: NO_PARAMS });
    const set = await h.cli('params', 'set', INVOICE, 'id=3');
    expect(set.code).toBe(0);
    expect(set.stderr).toContain('no watcher is running');
    expect(readJson(harnessFiles(h).sessionParams)).toMatchObject({ rev: 1, routes: { [INVOICE]: { path: '/manage/invoices/3', params: { id: '3' } } } });
  });
});

describe('sidecar goto with a route key', () => {
  it('fills the key through link discovery, and through session params once they are set', async () => {
    h = await createHarness({ config: NO_PARAMS });
    await h.start();
    const file = h.writeSidecar('team', `goto ${TEAM}\nstill team-page`);
    const discovered = await h.waitForFrame((e) => e.frame.route === `sidecar:${file}#team-page`, 40_000, { from: 0 });
    expect(discovered.frame.status).toBe('clean');
    expect(discovered.signals.text).toContain('U12'); // /manage/clubs/1/teams/10, found through /manage/clubs and /manage/clubs/1/teams

    // The agent points the route at another team; the scenario follows on its next replay.
    expect((await h.cli('params', 'set', TEAM, 'clubId=2', 'teamId=20')).code).toBe(0);
    const from = h.frames.length;
    h.writeSidecar('team', `goto ${TEAM}\nstill team-page\n`); // touch the scenario so it replays
    const replayed = await h.waitForFrame((e) => e.frame.route === `sidecar:${file}#team-page` && e.signals.text.includes('U10'), 30_000, { from });
    expect(replayed.frame.status).toBe('clean');
  });
});
