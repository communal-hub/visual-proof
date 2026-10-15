import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BEFORE_SCRATCH, mergeBase } from '../../src/before-base.js';
import { parseConfig, type Config } from '../../src/config.js';
import { runFinish, type FinishResult } from '../../src/finish.js';
import { headlineReason, normalizeScreen, scenarioHash, selectHeadlines } from '../../src/focus.js';
import { headTree } from '../../src/git.js';
import type { Dirs } from '../../src/paths.js';
import type { ImportGraph } from '../../src/resolve/import-graph.js';
import { sidecarRoute } from '../../src/sidecar.js';
import { Timeline, type NewFrame } from '../../src/timeline.js';
import type { FrameStatus } from '../../src/triage.js';
import { commitAll, git, initRepo, tmpDir, write } from './helpers.js';

const SHARED = 'src/shared/Calendar.vue';
const SC = '.visual-proof/sidecars/booking.vp';

const GRAPH: ImportGraph = {
  fileToRoutes: new Map([
    ['src/pages/Facility.vue', ['/facilities/:id']],
    ['src/pages/Users.vue', ['/users']],
    ['src/pages/Edit.vue', ['/edit']],
    [SHARED, ['/facilities/:id', '/users', '/edit', '/invites/:token']],
  ]),
  routes: [
    { path: '/facilities/:id', routeFile: 'src/router.js', component: 'src/pages/Facility.vue', layouts: [], dynamic: false },
    { path: '/users', routeFile: 'src/router.js', component: 'src/pages/Users.vue', layouts: [], dynamic: false },
    { path: '/edit', routeFile: 'src/router.js', component: 'src/pages/Edit.vue', layouts: [], dynamic: false },
    { path: '/invites/:token', routeFile: 'src/router.js', component: null, layouts: [], dynamic: false },
  ],
  unresolved: [],
};

let repo: string;
let dirs: Dirs;
let config: Config;

function configure(extra: Record<string, unknown> = {}): void {
  config = parseConfig(
    {
      appUrl: 'http://localhost:1',
      screenGlobs: ['src/**/*.vue'],
      routeParams: { '/facilities/:id': '/facilities/3' },
      baseRef: 'main',
      paramDiscovery: 'off',
      replay: { enabled: false },
      decisions: { enabled: false },
      ...extra,
    },
    repo,
    {},
  );
}

beforeEach(() => {
  repo = initRepo();
  for (const f of ['Facility', 'Users', 'Edit']) write(repo, `src/pages/${f}.vue`, `<template>${f}</template>\n`);
  write(repo, SHARED, '<template>calendar</template>\n');
  commitAll(repo, 'initial');
  git(repo, 'checkout', '-q', '-b', 'work');
  const root = tmpDir('vp-focus-');
  dirs = { statusDir: path.join(root, 'status'), artifactDir: path.join(root, 'artifacts'), scratchDir: path.join(root, 'status/scratch') };
  configure();
});

let seq = 0;
async function frame(route: string, status: FrameStatus = 'clean', extra: Partial<NewFrame> & { tree?: string; before?: boolean } = {}): Promise<void> {
  const { tree, before, ...rest } = extra;
  const dir = before ? path.join(dirs.scratchDir, BEFORE_SCRATCH) : dirs.scratchDir;
  new Timeline(dir, config.maxFrames).append(
    {
      sessionId: 's-test',
      route,
      routeKey: route,
      at: new Date(1_000_000 + seq++).toISOString(),
      treeHash: tree ?? (await headTree(repo))!,
      trigger: 'screen',
      status,
      reasons: status === 'clean' ? [] : [`${status} reason`],
      ...rest,
    },
    Buffer.from(`png:${route}:${status}:${seq}`),
  );
}

async function baseTree(): Promise<string> {
  return (await mergeBase(repo, 'main'))!.tree;
}

const claim = (text: string) => {
  fs.mkdirSync(dirs.statusDir, { recursive: true });
  fs.writeFileSync(path.join(dirs.statusDir, 'claim.md'), text);
};
const finish = (): Promise<FinishResult> => runFinish(config, { dirs, buildGraph: async () => GRAPH });
const editShared = () => {
  write(repo, SHARED, `<template>${Math.random()}</template>\n`);
  commitAll(repo, 'edit shared');
};

describe('focus helpers', () => {
  it('normalizes claim screens', () => {
    expect(normalizeScreen(' `/facilities/3/` ')).toBe('/facilities/3');
    expect(normalizeScreen('/')).toBe('/');
  });

  it('a claim screen, a changed page and a touched sidecar are headlines; the rest are impact', () => {
    const input = { focus: config.focus, claimScreens: ['/users'], graph: GRAPH, changed: [SHARED, 'src/pages/Edit.vue', SC] };
    const at = (route: string, sourceFiles = [SHARED]) => ({ route, routeKey: route, sourceFiles, via: 'screen' as const });
    expect(headlineReason(at('/users'), input)).toBe('claim');
    expect(headlineReason(at('/edit', ['src/pages/Edit.vue']), input)).toBe('page');
    expect(headlineReason(at('/edit'), input)).toBeNull();
    const still = { route: sidecarRoute(SC, 'open'), routeKey: sidecarRoute(SC, 'open'), sourceFiles: [SC], via: 'sidecar' as const, scenario: { file: SC, name: 'booking', still: 'open' } };
    expect(headlineReason(still, input)).toBe('sidecar');
    expect(headlineReason(still, { ...input, changed: [SHARED] })).toBeNull();
    expect(headlineReason(still, { ...input, changed: [SHARED], claimScreens: ['sidecar booking / open'] })).toBe('claim');
  });

  it('falls back to every route when nothing qualifies, and focus "all" makes everything a headline', () => {
    const routes = ['/users', '/edit'].map((route) => ({ route, routeKey: route, sourceFiles: [SHARED], via: 'screen' as const }));
    const input = { focus: config.focus, claimScreens: [], graph: GRAPH, changed: [SHARED] };
    expect(selectHeadlines(routes, input)).toMatchObject({ headlines: routes, impact: [], fallback: true });
    expect(selectHeadlines(routes, { ...input, focus: { mode: 'all' as const, maxImpact: 40 } })).toMatchObject({ headlines: routes, fallback: false });
  });
});

describe('finish with focus', () => {
  it('with no headline, the fallback note and the hint for missing frames tell the agent to name the claim screens', async () => {
    editShared();
    await frame('/users', 'clean');
    const result = await finish();
    expect(result.notes.some((n) => n.startsWith('focus: no claim screen') && n.includes(path.join(dirs.statusDir, 'claim.md')))).toBe(true);
    expect(result.failures).toContain('no frame at HEAD for /edit');
    const hint = result.hints.find((h) => h.startsWith('no route qualified as a headline'));
    expect(hint).toContain('focus.maxImpact (40)');
    expect(hint).toContain(`write \`<screen>: <what must be visible>\` lines to ${path.join(dirs.statusDir, 'claim.md')}`);
  });

  it('shows only the claim screen; impact routes that fail where the change did not render, or have no params, are notes', async () => {
    editShared();
    claim('/facilities/3: the booking spans the full column width\n');
    await frame('/facilities/3', 'clean', { renderedFiles: ['src/pages/Facility.vue', SHARED] });
    await frame('/users', 'error', { renderedFiles: ['src/pages/Users.vue'] });
    await frame('/edit', 'clean', { renderedFiles: ['src/pages/Edit.vue', SHARED] });
    const result = await finish();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.routes.filter((r) => r.role === 'headline').map((r) => r.route)).toEqual(['/facilities/3']);
    expect(result.impact).toEqual({
      total: 3,
      clean: 1,
      rendered: 1,
      unrelated: [{ route: '/users', status: 'error', reason: 'error reason' }],
      notCaptured: [{ route: '/invites/:token', reason: 'params unfilled' }],
    });
    expect(result.summary).toBe('visual-proof: 1 route ok, 3 impact');
    const block = result.proofBlock;
    expect(block.match(/<img /g)).toHaveLength(1);
    expect(block).toContain('**Impact smoke** · 3 other routes reach the change · 1 clean (1 rendered a changed file)');
    expect(block).toContain('- `/users` error: error reason');
    expect(block).toContain('| `/facilities/3` | the booking spans the full column width | _TODO_ | _TODO_ |');
    expect(block).not.toContain('| `/edit`');
  });

  it('an impact route that fails where the changed file rendered fails finish, unless it also fails at the merge-base', async () => {
    editShared();
    claim('/facilities/3: full width\n');
    await frame('/facilities/3', 'clean');
    await frame('/edit', 'error', { renderedFiles: ['src/pages/Edit.vue', SHARED] });
    let result = await finish();
    expect(result.failures).toEqual([`/edit final frame is error where ${SHARED} renders: error reason`]);
    expect(result.hints.some((h) => h.includes('npx visual-proof before'))).toBe(true);

    await frame('/edit', 'clean', { before: true, tree: await baseTree() });
    result = await finish();
    expect(result.failures).toEqual([`/edit final frame is error where ${SHARED} renders (clean at merge-base ${result.baseCommit!.slice(0, 8)}): error reason`]);

    await frame('/edit', 'error', { before: true, tree: await baseTree() });
    result = await finish();
    expect(result.failures).toEqual([]);
    expect(result.impact!.unrelated[0]!.reason).toMatch(/^also error at merge-base [0-9a-f]{8}; error reason$/);
  });

  it('a claimed route with unfilled params is still a failure', async () => {
    editShared();
    claim('/invites/:token: the invite calendar\n');
    const result = await finish();
    expect(result.failures.some((f) => f.startsWith('cannot capture /invites/:token: params unfilled'))).toBe(true);
  });

  it('without a matching claim every route is a headline, with a note saying how to focus', async () => {
    editShared();
    await frame('/facilities/3');
    await frame('/users');
    await frame('/edit');
    const result = await finish();
    expect(result.impact).toBeUndefined();
    expect(result.notes.some((n) => n.startsWith('focus: no claim screen'))).toBe(true);
    expect(result.failures.some((f) => f.includes('/invites/:token'))).toBe(true);
  });
});

describe('finish before/after', () => {
  it('pairs a headline with its merge-base frame', async () => {
    editShared();
    claim('/facilities/3: full width\n');
    await frame('/facilities/3', 'clean');
    await frame('/facilities/3', 'clean', { before: true, tree: await baseTree() });
    const result = await finish();
    expect(result.ok).toBe(true);
    const headline = result.routes.find((r) => r.route === '/facilities/3')!;
    expect(headline.before).toMatchObject({ status: 'clean', commit: result.baseCommit });
    expect(fs.readFileSync(headline.before!.artifact, 'utf8')).toMatch(/^png:\/facilities\/3:clean/);
    const short = result.baseCommit!.slice(0, 8);
    expect(path.basename(headline.before!.artifact)).toBe(`facilities-3-before-${short}.png`);
    expect(result.proofBlock).toContain(`| Before · merge-base \`${short}\` · clean | After · tree \`${result.treeHash!.slice(0, 8)}\` · clean |`);
    expect(result.proofBlock).toContain('alt="/facilities/3 (before)"');
    expect(result.proofBlock).toContain('against the current backend and seed data');
  });

  it('a missing before frame is a note by default and a failure with before.mode "require"', async () => {
    editShared();
    claim('/facilities/3: full width\n');
    await frame('/facilities/3', 'clean');
    let result = await finish();
    expect(result.ok).toBe(true);
    expect(result.notes.some((n) => n.startsWith('no before frame at merge-base') && n.includes('`/facilities/3`'))).toBe(true);
    configure({ before: { mode: 'require' } });
    result = await finish();
    expect(result.failures).toEqual([`no before frame at merge-base ${result.baseCommit!.slice(0, 8)} for \`/facilities/3\``]);
    configure({ before: { mode: 'off' } });
    result = await finish();
    expect(result.ok).toBe(true);
    expect(result.baseCommit).toBeUndefined();
  });

  it('a sidecar before frame from an older version of the scenario is not shown', async () => {
    const body = 'goto /facilities/3\nstill open\n';
    write(repo, SC, body);
    commitAll(repo, 'sidecar');
    const route = sidecarRoute(SC, 'open');
    await frame(route, 'clean', { trigger: 'sidecar', sourceFile: SC });
    await frame(route, 'clean', { trigger: 'sidecar', sourceFile: SC, before: true, tree: await baseTree(), scenarioHash: scenarioHash('old') });
    let result = await finish();
    expect(result.routes.find((r) => r.route === route)!.before).toBeUndefined();
    await frame(route, 'clean', { trigger: 'sidecar', sourceFile: SC, before: true, tree: await baseTree(), scenarioHash: scenarioHash(body) });
    result = await finish();
    expect(result.routes.find((r) => r.route === route)!.before).toBeDefined();
  });

  it('planOnly splits the routes without reading frames or writing the proof block', async () => {
    editShared();
    claim('/facilities/3: full width\n');
    const result = await runFinish(config, { dirs, buildGraph: async () => GRAPH, planOnly: true });
    expect(result.routes.map((r) => [r.route, r.role])).toEqual([
      ['/facilities/3', 'headline'],
      ['/edit', 'impact'],
      ['/users', 'impact'],
    ]);
    expect(fs.existsSync(result.proofBlockPath)).toBe(false);
  });
});
