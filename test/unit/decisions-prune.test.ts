import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../../src/config.js';
import { DecisionRuntime } from '../../src/decisions/runtime.js';
import { pruneForFinish } from '../../src/decisions/finish.js';
import { pruneForWatch } from '../../src/decisions/watch.js';
import type { ImportGraph } from '../../src/resolve/import-graph.js';
import { resolveRoutes } from '../../src/resolve/routes.js';
import { FakeClient, noul, okResult } from './decisions-helpers.js';
import { tmpDir, write } from './helpers.js';

const SHARED = 'src/shared/Badge.vue';
const KEYS = Array.from({ length: 8 }, (_, i) => `/p${i}`);

let repo: string;
let statusDir: string;
let config: Config;

/** 8 routes, each its own page, all rendering the shared badge (so one change fans out to 8). */
function graph(opts: { directPage?: string } = {}): ImportGraph {
  return {
    fileToRoutes: new Map([[SHARED, [...KEYS]], ...KEYS.map((k, i) => [`src/pages/P${i}.vue`, [k]] as [string, string[]])]),
    routes: KEYS.map((path, i) => ({
      path,
      routeFile: 'src/router.js',
      component: opts.directPage === path ? SHARED : `src/pages/P${i}.vue`,
      layouts: [],
      dynamic: false,
    })),
    unresolved: [],
  };
}

const resolution = (files: string[], g = graph()) => resolveRoutes(files, g, { appUrl: 'http://localhost:1', staticRoutes: {}, routeParams: {} });

/** Answers `noul` per asked route from a table of probabilities by route key. */
const answering = (table: Record<string, number>) =>
  new FakeClient((req) => {
    const answers: Record<string, ReturnType<typeof noul>> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const key = /renders\b/.test(q.instructions) ? /what (\S+) renders/.exec(q.instructions)![1]! : '';
      answers[id] = noul(table[key] ?? 0);
    }
    return okResult(answers, { model: 'typesafe/jev-1.13-20260917' });
  });

const runtime = (client: FakeClient | null, extra: Record<string, unknown> = {}) =>
  new DecisionRuntime({ config: config.decisions, env: {}, configDir: repo, client: client ?? undefined, ...extra });

beforeEach(() => {
  repo = tmpDir('vp-prune-');
  write(repo, SHARED, '<template><span>badge</span></template>\n');
  statusDir = path.join(tmpDir('vp-prune-status-'), 'status');
  fs.mkdirSync(statusDir, { recursive: true });
  config = parseConfig({ appUrl: 'http://localhost:1', decisions: { enabled: true } }, repo, {});
});

describe('route pruning', () => {
  it('asks nothing when the file fans out to no more than prune.above routes', async () => {
    const small: ImportGraph = { ...graph(), fileToRoutes: new Map([[SHARED, KEYS.slice(0, 6)]]) };
    const client = answering({});
    const out = await pruneForWatch(config, runtime(client), statusDir, [SHARED], resolution([SHARED], small), small, 'HEAD');
    expect(client.calls).toHaveLength(0);
    expect(out.routes).toHaveLength(6);
  });

  it('keeps the top 4 by probability and anything at 0.5 or more, drops the rest and sends one request', async () => {
    const client = answering({ '/p0': 0.2, '/p1': 0.9, '/p2': 0.1, '/p3': 0.8, '/p4': 0.55, '/p5': 0.7, '/p6': 0.6, '/p7': 0.05 });
    const out = await pruneForWatch(config, runtime(client), statusDir, [SHARED], resolution([SHARED]), graph(), 'HEAD');

    expect(client.calls).toHaveLength(1);
    const call = client.calls[0]!;
    expect(call.model).toBe('typesafe/jev-1.13');
    const state = call.state as { file: string; diff: string; routes: Array<{ key: string; components: string[] }> };
    expect(state.file).toBe(SHARED);
    expect(state.diff).toContain('badge'); // not a repo here: the file's own content stands in for the diff
    expect(state.routes.map((r) => r.key)).toEqual(KEYS);
    expect(state.routes[2]!.components).toEqual(['src/pages/P2.vue', SHARED]);
    expect(Object.values(call.questions).every((q) => q.type === 'noul')).toBe(true);
    expect(Object.keys(call.questions)).toHaveLength(8);
    expect(Object.values(call.questions)[0]!.instructions).toBe('Does this change visibly affect what /p0 renders?');

    // 0.9, 0.8, 0.7, 0.6 are the top four; 0.55 is kept too (>= 0.5); 0.2, 0.1, 0.05 go.
    expect(out.routes.map((r) => r.routeKey)).toEqual(['/p1', '/p3', '/p4', '/p5', '/p6']);
  });

  it('keeps exactly the top 4 when nothing reaches 0.5', async () => {
    const client = answering({ '/p0': 0.4, '/p1': 0.3, '/p2': 0.2, '/p3': 0.45, '/p4': 0.1, '/p5': 0.35, '/p6': 0.05, '/p7': 0.01 });
    const out = await pruneForWatch(config, runtime(client), statusDir, [SHARED], resolution([SHARED]), graph(), null);
    expect(out.routes.map((r) => r.routeKey)).toEqual(['/p0', '/p1', '/p3', '/p5']);
  });

  it('honors prune.above / prune.keep from the config and prune:false', async () => {
    const tight = parseConfig({ appUrl: 'http://localhost:1', decisions: { prune: { above: 2, keep: 1 } } }, repo, {});
    const client = answering({ '/p3': 0.4, '/p5': 0.3 });
    const out = await pruneForWatch(tight, new DecisionRuntime({ config: tight.decisions, env: {}, configDir: repo, client }), statusDir, [SHARED], resolution([SHARED]), graph(), null);
    expect(out.routes.map((r) => r.routeKey)).toEqual(['/p3']);

    const off = parseConfig({ appUrl: 'http://localhost:1', decisions: { prune: false } }, repo, {});
    const never = answering({});
    const all = await pruneForWatch(off, new DecisionRuntime({ config: off.decisions, env: {}, configDir: repo, client: never }), statusDir, [SHARED], resolution([SHARED]), graph(), null);
    expect(never.calls).toHaveLength(0);
    expect(all.routes).toHaveLength(8);
  });

  it('never prunes a route the diff touches directly, and does not ask about it', async () => {
    const g = graph({ directPage: '/p7' }); // /p7's page component IS the changed file
    const client = answering({}); // the model would say 0 for everything
    const out = await pruneForWatch(config, runtime(client), statusDir, [SHARED], resolution([SHARED], g), g, null);
    expect(out.routes.map((r) => r.routeKey)).toContain('/p7');
    expect(Object.keys(client.calls[0]!.questions)).toHaveLength(7);
    expect(Object.values(client.calls[0]!.questions).some((q) => q.instructions.includes('/p7 '))).toBe(false);
    // direct + the top 4 of the 7 asked (all zero: ties break by route key)
    expect(out.routes.map((r) => r.routeKey)).toEqual(['/p0', '/p1', '/p2', '/p3', '/p7']);
  });

  it('keeps every route when the request fails, the budget is gone or the model skips a route; and caches nothing', async () => {
    const failing = new FakeClient(() => ({ ok: false, kind: 'http', status: 503, error: 'HTTP 503', ms: 1 }));
    expect((await pruneForWatch(config, runtime(failing), statusDir, [SHARED], resolution([SHARED]), graph(), null)).routes).toHaveLength(8);

    const partial = new FakeClient(() => okResult({ r0: noul(0.9) }));
    expect((await pruneForWatch(config, runtime(partial), statusDir, [SHARED], resolution([SHARED]), graph(), null)).routes).toHaveLength(8);

    const noKey = await pruneForWatch(config, runtime(null), statusDir, [SHARED], resolution([SHARED]), graph(), null);
    expect(noKey.routes).toHaveLength(8);
    expect(fs.existsSync(path.join(statusDir, 'decisions-cache.json'))).toBe(false);
  });

  it('the watcher and finish use the SAME set: finish reads the watcher\'s cached decision and sends nothing', async () => {
    const table = { '/p0': 0.9, '/p1': 0.8, '/p2': 0.7, '/p3': 0.6, '/p4': 0.1, '/p5': 0.1, '/p6': 0.1, '/p7': 0.1 };
    const watchClient = answering(table);
    const watched = await pruneForWatch(config, runtime(watchClient), statusDir, [SHARED], resolution([SHARED]), graph(), null);
    expect(watchClient.calls).toHaveLength(1);
    const watchKeys = watched.routes.map((r) => r.routeKey);

    // finish: a client that would give the opposite answer proves the cache decides, not the model.
    const finishClient = answering({ '/p4': 1, '/p5': 1, '/p6': 1, '/p7': 1 });
    const finishRuntime = runtime(finishClient);
    const outcome = await pruneForFinish(config, finishRuntime, statusDir, [SHARED], resolution([SHARED]), graph(), 'main...HEAD');
    expect(finishClient.calls).toHaveLength(0);
    expect(finishRuntime.stats.requests).toBe(0);
    expect(outcome.cached).toEqual([SHARED]);
    const expected = resolution([SHARED]).routes.filter((r) => !outcome.dropped.has(r.routeKey)).map((r) => r.routeKey);
    expect(expected).toEqual(watchKeys);
    expect(outcome.notes[0]).toMatch(/^pruned 4 of 8 route\(s\) for src\/shared\/Badge\.vue: \/p4 0\.10, \/p5 0\.10, \/p6 0\.10, \/p7 0\.10 .*\(cached\)$/);

    // ...and with decisions off at finish (no client), the cached decision still applies.
    const offline = await pruneForFinish(config, runtime(null), statusDir, [SHARED], resolution([SHARED]), graph(), null);
    expect([...offline.dropped].sort()).toEqual(['/p4', '/p5', '/p6', '/p7']);
  });

  it('a different file content or a different route set is a different question', async () => {
    const client = answering({ '/p0': 0.9 });
    await pruneForWatch(config, runtime(client), statusDir, [SHARED], resolution([SHARED]), graph(), null);
    expect(client.calls).toHaveLength(1);

    await pruneForWatch(config, runtime(client), statusDir, [SHARED], resolution([SHARED]), graph(), null);
    expect(client.calls).toHaveLength(1); // cache hit

    write(repo, SHARED, '<template><span>badge v2</span></template>\n');
    await pruneForWatch(config, runtime(client), statusDir, [SHARED], resolution([SHARED]), graph(), null);
    expect(client.calls).toHaveLength(2); // new content

    const wider: ImportGraph = { ...graph(), fileToRoutes: new Map([[SHARED, [...KEYS, '/p8']]]) };
    await pruneForWatch(config, runtime(client), statusDir, [SHARED], resolution([SHARED], wider), wider, null);
    expect(client.calls).toHaveLength(3); // new route set
  });

  it('a route another changed file keeps stays in', async () => {
    write(repo, 'src/pages/P7.vue', '<template>p7</template>\n');
    const g = graph();
    const res = resolution([SHARED, 'src/pages/P7.vue'], g);
    const client = answering({ '/p0': 0.9, '/p1': 0.9, '/p2': 0.9, '/p3': 0.9 });
    const out = await pruneForWatch(config, runtime(client), statusDir, [SHARED, 'src/pages/P7.vue'], res, g, null);
    // /p7 is pruned for the badge but P7.vue (one route, no fan-out) keeps it.
    expect(out.routes.map((r) => r.routeKey)).toEqual(['/p0', '/p1', '/p2', '/p3', '/p7']);
  });

  it('shares one budget across prune phases and stops asking once it is spent', async () => {
    const client = answering({ '/p0': 0.9 });
    const rt = runtime(client);
    await rt.phase(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
    expect(rt.ms).toBeGreaterThanOrEqual(10);
    const tiny = parseConfig({ appUrl: 'http://localhost:1', decisions: { budgetMs: 5 } }, repo, {});
    const spent = new DecisionRuntime({ config: tiny.decisions, env: {}, configDir: repo, client });
    await spent.phase(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const out = await pruneForFinish(tiny, spent, statusDir, [SHARED], resolution([SHARED]), graph(), null);
    expect(client.calls).toHaveLength(0);
    expect(out.dropped.size).toBe(0);
  });
});
