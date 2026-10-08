import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../../src/config.js';
import { finishCommand, routeSlug, runFinish, type FinishResult } from '../../src/finish.js';
import { headTree } from '../../src/git.js';
import type { Dirs } from '../../src/paths.js';
import type { ImportGraph } from '../../src/resolve/import-graph.js';
import { Timeline, type NewFrame } from '../../src/timeline.js';
import type { FrameStatus } from '../../src/triage.js';
import { commitAll, git, initRepo, tmpDir, write } from './helpers.js';

let repo: string;
let dirs: Dirs;
let config: Config;
let env: NodeJS.ProcessEnv;

const graph = (entries: Record<string, string[]>): ImportGraph => ({
  fileToRoutes: new Map(Object.entries(entries)),
  routes: [...new Set(Object.values(entries).flat())].map((p) => ({
    path: p,
    routeFile: 'src/router.js',
    component: null,
    layouts: [],
    dynamic: false,
  })),
  unresolved: [],
});

const GRAPH = graph({
  'src/pages/A.vue': ['/a'],
  'src/pages/B.vue': ['/b/:id'],
  'src/pages/Home.vue': ['/'],
  'src/pages/C.vue': ['/c'],
  'src/shared/S.vue': ['/a', '/c'],
});

function configure(extra: Record<string, unknown> = {}): void {
  config = parseConfig(
    {
      appUrl: 'http://localhost:1',
      screenGlobs: ['src/**/*.vue'],
      backendGlobs: ['server/**'],
      routeParams: { '/b/:id': '/b/1' },
      baseRef: 'main',
      ...extra,
    },
    repo,
    {},
  );
}

beforeEach(() => {
  repo = initRepo();
  for (const f of ['A', 'B', 'C', 'Home']) write(repo, `src/pages/${f}.vue`, `<template>${f}</template>\n`);
  write(repo, 'src/shared/S.vue', '<template>shared</template>\n');
  write(repo, 'server/data.json', '{}\n');
  write(repo, 'README.md', '# readme\n');
  commitAll(repo, 'initial');
  git(repo, 'checkout', '-q', '-b', 'work');

  const root = tmpDir('vp-finish-');
  dirs = { statusDir: path.join(root, 'status'), artifactDir: path.join(root, 'artifacts'), scratchDir: path.join(root, 'status/scratch') };
  env = { VISUAL_PROOF_STATUS_DIR: dirs.statusDir, VISUAL_PROOF_ARTIFACT_DIR: dirs.artifactDir };
  configure();
});

let seq = 0;
/** Record a frame the way the daemon would, at the given tree (default: HEAD's). */
async function frame(
  route: string,
  status: FrameStatus = 'clean',
  extra: Partial<NewFrame> & { tree?: string } = {},
): Promise<void> {
  const { tree, ...rest } = extra;
  new Timeline(dirs.scratchDir, config.maxFrames).append(
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

const finish = (opts: Parameters<typeof runFinish>[1] = {}): Promise<FinishResult> =>
  runFinish(config, { dirs, buildGraph: async () => GRAPH, ...opts });

function editAndCommit(file: string, body = `<template>${Math.random()}</template>\n`): void {
  write(repo, file, body);
  commitAll(repo, `edit ${file}`);
}

describe('routeSlug', () => {
  it.each([
    ['/', 'root'],
    ['/reports', 'reports'],
    ['/manage/invoices/1', 'manage-invoices-1'],
    ['/a b/c?x=1&y=2', 'a_b-c_x_1_y_2'],
    ['/../etc', '..-etc'],
    ['', 'root'],
  ])('%s -> %s', (route, slug) => {
    expect(routeSlug(route)).toBe(slug);
    expect(slug).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('runFinish', () => {
  it('reports no screen changes when only non-screen files changed', async () => {
    editAndCommit('README.md', '# changed\n');
    const result = await finish();
    expect(result).toMatchObject({ ok: true, noScreenChanges: true, failures: [], routes: [], summary: 'visual-proof: no screen changes' });
    expect(fs.readFileSync(result.proofBlockPath, 'utf8')).toBe('<!-- visual-proof: no screen changes (diffed main...HEAD) -->\n');
    expect(fs.readdirSync(dirs.artifactDir)).toEqual([]);
  });

  it('writes a proof block with one img per route and copies the headline PNGs', async () => {
    editAndCommit('src/pages/A.vue');
    editAndCommit('src/pages/Home.vue');
    await frame('/a');
    await frame('/');
    const result = await finish();
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('visual-proof: 2 routes ok');

    const tree = (await headTree(repo))!;
    const short = tree.slice(0, 8);
    expect(fs.readdirSync(dirs.artifactDir).sort()).toEqual([`a-${short}.png`, `root-${short}.png`]);
    expect(fs.readFileSync(path.join(dirs.artifactDir, `a-${short}.png`), 'utf8')).toMatch(/^png:\/a:clean/);

    const block = fs.readFileSync(result.proofBlockPath, 'utf8');
    expect(block).toBe(fs.readFileSync(path.join(dirs.statusDir, 'proof-block.md'), 'utf8'));
    expect(block.split('\n')[0]).toBe(`**Visual proof** · tree \`${short}\` · session \`s-test\``);
    expect(block.match(/<img /g)).toHaveLength(2);
    expect(block).toContain(`<img src="${path.join(dirs.artifactDir, `a-${short}.png`)}" alt="/a">`);
    expect(block).toContain(`\`/a\` · clean · tree ${short}`);
    expect(block).toContain(`\`/\` · clean · tree ${short}`);
    expect(block).not.toContain('Failures');
  });

  it('fails with "no frame at HEAD" when the only frame is at another tree', async () => {
    await frame('/a', 'clean', { tree: 'f'.repeat(40) });
    editAndCommit('src/pages/A.vue');
    const result = await finish();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['no frame at HEAD for /a']);
    expect(result.summary).toBe(`visual-proof: 1 failure, see ${result.proofBlockPath}`);
    const block = fs.readFileSync(result.proofBlockPath, 'utf8');
    expect(block).toContain('**Failures**');
    expect(block).toContain('- no frame at HEAD for /a');
    expect(block).not.toContain('<img');
    expect(fs.readdirSync(dirs.artifactDir)).toEqual([]);
  });

  it('never falls back to an earlier clean frame when the final frame is not clean', async () => {
    await frame('/a', 'clean', { tree: 'e'.repeat(40) });
    editAndCommit('src/pages/A.vue');
    await frame('/a', 'error', { reasons: ['console error: boom'] });
    const result = await finish();
    expect(result.failures).toEqual(['/a final frame is error: console error: boom']);
    const short = (await headTree(repo))!.slice(0, 8);
    expect(result.routes[0]).toMatchObject({ route: '/a', status: 'error' });
    // The headline shown is the error frame, not the earlier clean one.
    expect(fs.readFileSync(path.join(dirs.artifactDir, `a-${short}.png`), 'utf8')).toMatch(/:error:/);
    expect(fs.readFileSync(result.proofBlockPath, 'utf8')).toContain(`\`/a\` · error · tree ${short}`);
  });

  it('uses the latest frame at HEAD: a clean frame followed by a loading frame fails, the reverse passes', async () => {
    editAndCommit('src/pages/A.vue');
    await frame('/a', 'clean');
    await frame('/a', 'loading');
    expect((await finish()).failures).toEqual(['/a final frame is loading: loading reason']);

    await frame('/a', 'clean');
    expect((await finish()).ok).toBe(true);
  });

  it('matches frames by routeKey as well as by concrete route', async () => {
    editAndCommit('src/pages/B.vue');
    expect((await finish()).failures).toEqual(['no frame at HEAD for /b/1']);
    await frame('/b/1', 'clean', { routeKey: '/b/:id' });
    expect((await finish()).ok).toBe(true);
  });

  it('re-adds every captured resolvable route when a backend file changed', async () => {
    await frame('/a', 'clean', { tree: 'a'.repeat(40) });
    await frame('/b/1', 'clean', { routeKey: '/b/:id', tree: 'a'.repeat(40) });
    await frame('/gone', 'clean', { tree: 'a'.repeat(40) });
    editAndCommit('server/data.json', '{"v":2}\n');
    await frame('/a', 'clean', { trigger: 'backend' });

    const result = await finish();
    expect(result.routes.map((r) => [r.route, r.via])).toEqual([
      ['/a', 'backend'],
      ['/b/1', 'backend'],
    ]);
    expect(result.failures).toEqual(['no frame at HEAD for /b/1']);
    expect(result.notes.join('\n')).toContain('captured route /gone no longer resolves');
  });

  it('fails a backend change when no route was ever captured, instead of passing with nothing to prove', async () => {
    editAndCommit('server/data.json', '{"v":2}\n');
    const result = await finish();
    expect(result).toMatchObject({ ok: false, routes: [], noScreenChanges: false });
    expect(result.failures).toEqual([
      'backend change (server/data.json) has no captured route to prove; open a page so the watcher captures it, or add staticRoutes',
    ]);
    expect(result.summary).toBe(`visual-proof: 1 failure, see ${result.proofBlockPath}`);
  });

  it("takes a backend change's routes from the current daemon session only, when status.json names one", async () => {
    fs.mkdirSync(dirs.statusDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.statusDir, 'status.json'), JSON.stringify({ state: 'ready', sessionId: 's-now' }));
    await frame('/a', 'clean', { sessionId: 's-old', tree: 'a'.repeat(40) });
    editAndCommit('server/data.json', '{"v":2}\n');
    // Only an older session captured /a: nothing from this session to prove.
    expect((await finish()).failures[0]).toMatch(/^backend change \(server\/data\.json\) has no captured route/);

    await frame('/c', 'clean', { sessionId: 's-now' });
    const result = await finish();
    expect(result.routes.map((r) => r.route)).toEqual(['/c']);
    expect(result.ok).toBe(true);
  });

  it('fails a changed screen that no route reaches, naming the way out', async () => {
    write(repo, 'src/orphan/Lonely.vue', '<template>x</template>\n');
    commitAll(repo, 'orphan');
    const result = await finish();
    expect(result.failures).toEqual([
      'no route for src/orphan/Lonely.vue (not reachable from routeFiles; add staticRoutes or ignoreScreenGlobs)',
    ]);
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(result.proofBlockPath, 'utf8')).toContain('- no route for src/orphan/Lonely.vue');
  });

  it('fails a route whose params are unfilled, pointing at routeParams', async () => {
    configure({ routeParams: {} });
    editAndCommit('src/pages/B.vue');
    editAndCommit('src/pages/A.vue');
    await frame('/a');
    const result = await finish();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      'cannot capture /b/:id: no routeParams entry for /b/:id (params: :id) (add routeParams)',
    ]);
    expect(result.routes.map((r) => r.route)).toEqual(['/a']);
  });

  it('ignoreScreenGlobs removes files from the screen set entirely', async () => {
    configure({ ignoreScreenGlobs: ['src/orphan/**', 'src/pages/B.vue'] });
    write(repo, 'src/orphan/Lonely.vue', '<template>x</template>\n');
    commitAll(repo, 'orphan');
    editAndCommit('src/pages/B.vue');
    expect(await finish()).toMatchObject({ ok: true, noScreenChanges: true, failures: [] });

    editAndCommit('src/pages/A.vue');
    await frame('/a');
    const result = await finish();
    expect(result.ok).toBe(true);
    expect(result.routes.map((r) => r.route)).toEqual(['/a']);
  });

  it('keeps the route-graph failure as the only failure when the graph cannot be built', async () => {
    write(repo, 'src/orphan/Lonely.vue', '<template>x</template>\n');
    commitAll(repo, 'orphan');
    const result = await finish({ buildGraph: async () => Promise.reject(new Error('bad router file')) });
    expect(result.failures).toEqual(['could not build the route graph: bad router file']);
  });

  it('puts the failures section before the routes', async () => {
    editAndCommit('src/pages/A.vue');
    editAndCommit('src/pages/C.vue');
    await frame('/c');
    const block = fs.readFileSync((await finish()).proofBlockPath, 'utf8');
    expect(block.indexOf('**Failures**')).toBeGreaterThan(0);
    expect(block.indexOf('**Failures**')).toBeLessThan(block.indexOf('<img'));
  });

  it('gives routes with the same slug distinct artifact names', async () => {
    configure({ staticRoutes: { 'src/pages/Odd.vue': ['/x/y', '/x-y'] } });
    editAndCommit('src/pages/Odd.vue');
    await frame('/x/y');
    await frame('/x-y');
    const result = await finish({ buildGraph: async () => graph({}) });
    expect(result.ok).toBe(true);
    expect(new Set(result.routes.map((r) => r.artifact)).size).toBe(2);
  });

  it('shares one artifact per route when several files fan out to it', async () => {
    editAndCommit('src/shared/S.vue');
    await frame('/a');
    await frame('/c');
    const result = await finish();
    expect(result.routes.map((r) => r.route)).toEqual(['/a', '/c']);
    expect(fs.readdirSync(dirs.artifactDir)).toHaveLength(2);
  });

  it('resolves a change in a config subdirectory of the git repo (paths are relative to the config, not the toplevel)', async () => {
    write(repo, 'sub/src/pages/A.vue', '<template>a</template>\n');
    commitAll(repo, 'sub app');
    write(repo, 'sub/src/pages/A.vue', '<template>a2</template>\n');
    write(repo, 'src/pages/B.vue', '<template>outside the config dir</template>\n');
    commitAll(repo, 'edit');
    config = parseConfig({ appUrl: 'http://localhost:1', baseRef: 'main' }, path.join(repo, 'sub'), {});

    expect((await finish()).failures).toEqual(['no frame at HEAD for /a']);
    await frame('/a');
    const result = await finish();
    expect(result.failures).toEqual([]);
    expect(result.routes.map((r) => r.route)).toEqual(['/a']);
  });

  it('fails when the frame PNG is gone', async () => {
    editAndCommit('src/pages/A.vue');
    await frame('/a');
    const timeline = new Timeline(dirs.scratchDir, config.maxFrames);
    fs.rmSync(timeline.pngPath(timeline.list()[0]!));
    expect((await finish()).failures[0]).toMatch(/^frame f-\d+ for \/a has no PNG on disk/);
  });

  it('fails clearly when HEAD has no commits', async () => {
    const empty = initRepo();
    config = parseConfig({ appUrl: 'http://localhost:1' }, empty, {});
    const result = await finish();
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('HEAD has no commits');
    expect(fs.readFileSync(result.proofBlockPath, 'utf8')).toContain('HEAD has no commits');
  });

  it('truncates when the budget is exhausted before any route is done', async () => {
    editAndCommit('src/pages/A.vue');
    await frame('/a');
    const result = await finish({
      budgetMs: 1,
      buildGraph: async () => {
        const until = Date.now() + 10;
        while (Date.now() < until) {
          // busy-wait so the deadline passes before the first route is looked at
        }
        return GRAPH;
      },
    });
    expect(result.truncated).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.startsWith('truncated: finish budget of 1 ms exceeded'))).toBe(true);
    expect(fs.readFileSync(result.proofBlockPath, 'utf8')).toContain('truncated');
  });

  it('truncates when a step never returns, within the budget', async () => {
    editAndCommit('src/pages/A.vue');
    const t0 = Date.now();
    const result = await finish({ budgetMs: 150, buildGraph: () => new Promise(() => {}) });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(result.truncated).toBe(true);
    expect(result.failures).toEqual(['truncated: finish budget of 150 ms exceeded after 0 of 0 route(s)']);
    expect(fs.existsSync(result.proofBlockPath)).toBe(true);
  });

  it('reports a route-graph failure instead of throwing', async () => {
    editAndCommit('src/pages/A.vue');
    const result = await finish({ buildGraph: async () => Promise.reject(new Error('bad router file')) });
    expect(result.failures).toEqual(['could not build the route graph: bad router file']);
  });
});

describe('runFinish when working directly on the base branch', () => {
  beforeEach(() => {
    git(repo, 'checkout', '-q', 'main'); // base...HEAD is empty here whatever gets committed
  });

  it('a screen change committed on main is still expected (HEAD~1..HEAD without an anchor)', async () => {
    editAndCommit('src/pages/A.vue');
    const result = await finish();
    expect(result.failures).toEqual(['no frame at HEAD for /a']);
    expect(result.range).toBe('HEAD~1..HEAD');
    expect(fs.readFileSync(result.proofBlockPath, 'utf8')).toContain('- diffed HEAD~1..HEAD');
    await frame('/a');
    expect((await finish()).ok).toBe(true);
  });

  it("uses the daemon's anchor from status.json: every commit since it started", async () => {
    const anchor = git(repo, 'rev-parse', 'HEAD');
    fs.mkdirSync(dirs.statusDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.statusDir, 'status.json'), JSON.stringify({ state: 'stopped', anchor }));
    editAndCommit('src/pages/A.vue');
    editAndCommit('src/pages/C.vue');
    await frame('/c');
    const result = await finish();
    expect(result.range).toBe(`${anchor.slice(0, 8)}..HEAD`);
    expect(result.failures).toEqual(['no frame at HEAD for /a']);
    expect(fs.readFileSync(result.proofBlockPath, 'utf8')).toContain(`- diffed ${anchor.slice(0, 8)}..HEAD`);
  });

  it('with the anchor at HEAD and nothing uncommitted there is genuinely nothing to prove', async () => {
    fs.mkdirSync(dirs.statusDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.statusDir, 'status.json'), JSON.stringify({ state: 'ready', anchor: git(repo, 'rev-parse', 'HEAD') }));
    expect(await finish()).toMatchObject({ ok: true, noScreenChanges: true });
  });
});

describe('finishCommand', () => {
  const writeConfig = (extra: Record<string, unknown> = {}): string => {
    const file = path.join(repo, 'visual-proof.config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ appUrl: 'http://localhost:1', screenGlobs: ['src/**/*.vue'], backendGlobs: ['server/**'], ...extra }),
    );
    return file;
  };

  async function run(hook: boolean, configPath = writeConfig()) {
    let stdout = '';
    let stderr = '';
    const code = await finishCommand({ configPath, hook, env, out: (t) => (stdout += t), err: (t) => (stderr += t) });
    return { code, stdout, stderr };
  }

  it('prints only "no screen changes" and exits 0', async () => {
    editAndCommit('README.md', '# changed\n');
    expect(await run(false)).toEqual({ code: 0, stdout: 'no screen changes\n', stderr: '' });
  });

  it('exits 1 on failure, printing the block path on stdout and failures on stderr', async () => {
    editAndCommit('src/pages/A.vue');
    const r = await run(false, writeConfig({ staticRoutes: { 'src/pages/A.vue': ['/a'] } }));
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(`${path.join(dirs.statusDir, 'proof-block.md')}\n`);
    expect(r.stderr).toBe('visual-proof finish: no frame at HEAD for /a\n');
  });

  it('exits 1 when A.vue has no route: the block path on stdout, the way out on stderr', async () => {
    editAndCommit('src/pages/A.vue');
    const r = await run(false);
    expect(r.code).toBe(1);
    expect(r.stdout.trim()).toBe(path.join(dirs.statusDir, 'proof-block.md'));
    expect(r.stderr).toContain('no route for src/pages/A.vue (not reachable from routeFiles; add staticRoutes or ignoreScreenGlobs)');
  });

  it('--hook prints exactly one line and exits 0, recording lastFinish without clobbering status.json', async () => {
    fs.mkdirSync(dirs.statusDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.statusDir, 'status.json'), JSON.stringify({ state: 'ready', sessionId: 's-1', frames: 7 }));
    const file = writeConfig({ staticRoutes: { 'src/pages/A.vue': ['/a'] } });
    editAndCommit('src/pages/A.vue');

    const r = await run(true, file);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(`visual-proof: 1 failure, see ${path.join(dirs.statusDir, 'proof-block.md')}\n`);

    const status = JSON.parse(fs.readFileSync(path.join(dirs.statusDir, 'status.json'), 'utf8'));
    expect(status).toMatchObject({ state: 'ready', sessionId: 's-1', frames: 7 });
    expect(status.lastFinish).toMatchObject({ ok: false, failures: ['no frame at HEAD for /a'] });
    expect(Date.parse(status.lastFinish.at)).not.toBeNaN();
    expect(fs.readFileSync(path.join(dirs.statusDir, 'watcher.log'), 'utf8')).toMatch(/^\S+ finish failure: no frame at HEAD for \/a$/m);
  });

  it('--hook still exits 0 with one line when the config is broken', async () => {
    const r = await run(true, path.join(repo, 'missing.json'));
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.stdout).toContain('finish error: config file not found');
    expect(JSON.parse(fs.readFileSync(path.join(dirs.statusDir, 'status.json'), 'utf8')).lastFinish.ok).toBe(false);
  });

  it('without --hook a broken config exits 1 with a one-line reason', async () => {
    const r = await run(false, path.join(repo, 'missing.json'));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^visual-proof finish: config file not found: .*\n$/);
    expect(r.stdout).toBe('');
  });

  it('creates status.json with a stopped state when no daemon ever ran', async () => {
    editAndCommit('README.md', '# changed\n');
    await run(true);
    const status = JSON.parse(fs.readFileSync(path.join(dirs.statusDir, 'status.json'), 'utf8'));
    expect(status).toMatchObject({ state: 'stopped', lastFinish: { ok: true, failures: [] } });
  });
});
