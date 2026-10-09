import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig, type Config } from '../../src/config.js';
import { writeTextSidecar } from '../../src/decisions/sidecar.js';
import { pruneForWatch } from '../../src/decisions/watch.js';
import { DecisionRuntime } from '../../src/decisions/runtime.js';
import { finishCommand, runFinish, type FinishResult } from '../../src/finish.js';
import { headTree } from '../../src/git.js';
import type { Dirs } from '../../src/paths.js';
import type { ImportGraph } from '../../src/resolve/import-graph.js';
import { resolveRoutes } from '../../src/resolve/routes.js';
import { Timeline } from '../../src/timeline.js';
import { CLEAN_PNG, FakeClient, choice, hang, noul, okResult } from './decisions-helpers.js';
import { commitAll, git, initRepo, tmpDir, write } from './helpers.js';

let repo: string;
let dirs: Dirs;
let config: Config;

const graph = (entries: Record<string, string[]>): ImportGraph => ({
  fileToRoutes: new Map(Object.entries(entries)),
  routes: [...new Set(Object.values(entries).flat())].map((p) => ({ path: p, routeFile: 'src/router.js', component: null, layouts: [], dynamic: false })),
  unresolved: [],
});
const GRAPH = graph({ 'src/pages/A.vue': ['/a'], 'src/pages/Home.vue': ['/'], 'src/pages/C.vue': ['/c'] });

function configure(decisions: Record<string, unknown> = { enabled: true }, extra: Record<string, unknown> = {}): void {
  config = parseConfig(
    { appUrl: 'http://localhost:1', screenGlobs: ['src/**/*.vue'], backendGlobs: ['server/**'], baseRef: 'main', decisions, ...extra },
    repo,
    {},
  );
}

beforeEach(() => {
  repo = initRepo();
  for (const f of ['A', 'C', 'Home']) write(repo, `src/pages/${f}.vue`, `<template>${f}</template>\n`);
  commitAll(repo, 'initial');
  git(repo, 'checkout', '-q', '-b', 'work');
  const root = tmpDir('vp-dfinish-');
  dirs = { statusDir: path.join(root, 'status'), artifactDir: path.join(root, 'artifacts'), scratchDir: path.join(root, 'status/scratch') };
  configure();
});

let seq = 0;
/** A clean frame at HEAD the way the daemon records it, with the page text sidecar. */
async function frame(route: string, text = `page text of ${route}`, routeKey = route): Promise<void> {
  const timeline = new Timeline(dirs.scratchDir, config.maxFrames);
  const tree = (await headTree(repo))!;
  const f = timeline.append(
    { sessionId: 's-test', route, routeKey, at: new Date(1_000_000 + seq++).toISOString(), treeHash: tree, trigger: 'screen', status: 'clean', reasons: [], renderedFiles: null },
    fs.readFileSync(route == "/a" ? path.join(path.dirname(CLEAN_PNG), "error.png") : CLEAN_PNG),
  );
  if (text) writeTextSidecar(timeline.pngPath(f), text);
}

function edit(file: string, body = `<template>${Math.random()}</template>\n`): void {
  write(repo, file, body);
  commitAll(repo, `edit ${file}`);
}

const finish = (client: FakeClient | undefined, extra: Parameters<typeof runFinish>[1] = {}): Promise<FinishResult> =>
  runFinish(config, { dirs, env: {}, buildGraph: async () => GRAPH, ...(client ? { decisionsClient: client } : {}), ...extra });

/** Image requests get a choice, text requests get answers per question shape. */
function scripted(opts: { image?: () => ReturnType<typeof choice>; inputTokens?: number; noulP?: number; pick?: string } = {}): FakeClient {
  return new FakeClient((req) => {
    const answers: Record<string, ReturnType<typeof choice> | ReturnType<typeof noul>> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      if (id === 'frame') answers[id] = (opts.image ?? (() => choice('clean')))();
      else if (q.type === 'noul') answers[id] = noul(opts.noulP ?? 0.9);
      else answers[id] = choice(opts.pick ?? 'a', 0.9);
    }
    return okResult(answers, { inputTokens: Array.isArray(req.state) ? (opts.inputTokens ?? 1188) : 400, cost: Array.isArray(req.state) ? 0.0001188 : 0.00002 });
  });
}

describe('finish without decisions', () => {
  it('makes no request and changes nothing in the proof block when there is no key (the default)', async () => {
    configure({});
    edit('src/pages/A.vue');
    await frame('/a');
    const result = await finish(undefined);
    expect(result.ok).toBe(true);
    expect(result.decisions).toBeUndefined();
    expect(result.claim).toBeUndefined();
    expect(result.notes.filter((n) => /decisions|image check|claim/.test(n))).toEqual([]);
    const block = fs.readFileSync(result.proofBlockPath, 'utf8');
    expect(block).not.toMatch(/decisions:|Claim check|image check/);
    expect(result.routes[0]!.imageCheck).toBeUndefined();
  });

  it('says so in a note when decisions.enabled is true but there is no key', async () => {
    edit('src/pages/A.vue');
    await frame('/a');
    const result = await finish(undefined);
    expect(result.ok).toBe(true);
    expect(result.notes).toContain('decisions are enabled but OPENROUTER_API_KEY is not set (environment or .env next to the config); using DOM heuristics only');
  });

  it('decisions.enabled:false ignores even an injected client', async () => {
    configure({ enabled: false });
    edit('src/pages/A.vue');
    await frame('/a');
    const client = scripted();
    const result = await finish(client);
    expect(client.calls).toHaveLength(0);
    expect(result.decisions).toBeUndefined();
  });
});

describe('image check at finish', () => {
  it('triage "fail": a non-clean answer at 0.7+ for a clean-by-DOM frame fails finish with the documented text', async () => {
    configure({ enabled: true, triage: 'fail', verdict: false, captions: false });
    edit('src/pages/A.vue');
    edit('src/pages/Home.vue');
    await frame('/a');
    await frame('/');
    const client = new FakeClient((req) => {
      const first = (req.state as Array<{ image_url: { url: string } }>)[0]!.image_url.url;
      const isA = Buffer.from(first.split(',')[1]!, 'base64').equals(fs.readFileSync(path.join(path.dirname(CLEAN_PNG), 'error.png')));
      return okResult({ frame: isA ? choice('error', 0.95) : choice('clean', 0.99) });
    });
    const result = await finish(client);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['/a looks error to the image check (0.95)']);
    expect(client.imageCalls).toHaveLength(2);
    expect(client.textCalls).toHaveLength(0);
    const a = result.routes.find((r) => r.route === '/a')!;
    expect(a.status).toBe('clean'); // the DOM said clean; the image check is a separate record
    expect(a.imageCheck).toMatchObject({ label: 'error', confidence: 0.95, action: 'fail', model: 'fake/model-1' });
    const block = fs.readFileSync(result.proofBlockPath, 'utf8');
    expect(block).toContain('- /a looks error to the image check (0.95)');
    expect(block).toContain('`/a` · clean · tree');
    expect(block).toContain('image check: error (0.95)');
    expect(block).toContain('image check: clean (0.99)');
  });

  it('triage "warn" (the default) only adds a note; below 0.7 is not acted on', async () => {
    configure({ enabled: true, verdict: false, captions: false });
    edit('src/pages/A.vue');
    edit('src/pages/Home.vue');
    await frame('/a');
    await frame('/');
    let n = 0;
    const client = scripted({ image: () => (n++ === 0 ? choice('blank', 0.8) : choice('error', 0.69)) });
    const result = await finish(client);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.notes.filter((x) => x.includes('image check'))).toHaveLength(1);
    expect(result.notes.some((x) => /^\/(a|) looks blank to the image check \(0\.80\)$/.test(x))).toBe(true);
  });

  it('triage "off" sends no image request', async () => {
    configure({ enabled: true, triage: 'off', verdict: false, captions: false });
    edit('src/pages/A.vue');
    await frame('/a');
    const client = scripted();
    const result = await finish(client);
    expect(client.calls).toHaveLength(0);
    expect(result.routes[0]!.imageCheck).toBeUndefined();
  });

  it('the wrong-encoding guard: an image request reporting wildly inflated input tokens is unknown, noted and never fails finish', async () => {
    configure({ enabled: true, triage: 'fail', verdict: false, captions: false });
    edit('src/pages/A.vue');
    await frame('/a');
    const result = await finish(scripted({ image: () => choice('error', 1), inputTokens: 17_233 }));
    expect(result.ok).toBe(true);
    expect(result.routes[0]!.imageCheck).toMatchObject({ label: 'unknown', action: 'none' });
    expect(result.notes.some((x) => x.startsWith('image check unknown for /a:') && x.includes('17233 input tokens'))).toBe(true);
    expect(fs.readFileSync(path.join(dirs.statusDir, 'watcher.log'), 'utf8')).toContain('decisions: ERROR image check for /a used 17233 input tokens');
  });

  it('a provider outage leaves the DOM verdict alone (notes, no failure)', async () => {
    configure({ enabled: true, triage: 'fail', verdict: false, captions: false });
    edit('src/pages/A.vue');
    await frame('/a');
    const result = await finish(new FakeClient(() => ({ ok: false, kind: 'http', status: 503, error: 'HTTP 503: down', ms: 4 })));
    expect(result.ok).toBe(true);
    expect(result.notes).toContain('image check unknown for /a: HTTP 503: down');
  });
});

describe('claim verdict, captions and accounting at finish', () => {
  it('prints ready-to-paste claim markdown in normal finish output, with JSON and hook formats preserved', async () => {
    configure({ enabled: true, captions: false, triage: 'off' }, { staticRoutes: { 'src/pages/A.vue': ['/a'] }, replay: { enabled: false } });
    edit('src/pages/A.vue');
    await frame('/a');
    write(dirs.statusDir, 'claim.md', '- The page shows scanned members\n');
    const configPath = path.join(repo, 'visual-proof.config.json');
    fs.writeFileSync(configPath, JSON.stringify(config));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      model: config.decisions.models.triage, answers: { c0: noul(0.02), reason0: choice('empty_state') },
      usage: { input_tokens: 1200, output_tokens: 0, cost: 0.00012 },
    }), { status: 200 }));
    const env = { OPENROUTER_API_KEY: 'test-key', VISUAL_PROOF_STATUS_DIR: dirs.statusDir, VISUAL_PROOF_ARTIFACT_DIR: dirs.artifactDir, VISUAL_PROOF_SCRATCH_DIR: dirs.scratchDir };
    try {
      let stdout = '';
      const context = { configPath, env, out: (t: string) => { stdout += t; }, err: () => {} };
      expect(await finishCommand({ ...context, hook: false })).toBe(0);
      expect(stdout).toContain('**Claim check (advisory)**');
      expect(stdout).toContain('Overall: not visible');
      expect(stdout).toContain('empty state contradicts');
      expect(stdout).toContain('Advisory — reviewer decides.');
      stdout = '';
      await finishCommand({ ...context, hook: false, json: true });
      expect(JSON.parse(stdout).claim.verdict).toBe('not visible');
      stdout = '';
      await finishCommand({ ...context, hook: true });
      expect(stdout.trim().split('\n')).toHaveLength(1);
      expect(stdout).not.toContain('**Claim check');
    } finally { fetchMock.mockRestore(); }
  });

  it('writes the advisory claim section, a caption under each still and the decisions footer; at most 3 text requests', async () => {
    configure({ enabled: true });
    edit('src/pages/A.vue');
    edit('src/pages/Home.vue');
    await frame('/a', 'Alpha page total 12');
    await frame('/', 'Home welcome');
    write(path.dirname(dirs.statusDir) + '/status', 'claim.md', '# Claim\n- Alpha shows a total\n- Home shows a welcome\n');

    const client = scripted({ noulP: 0.9, pick: 'b' });
    const result = await finish(client);
    expect(result.ok).toBe(true);

    // 2 triage images + 1 vision verdict + 1 text captions = 4 requests.
    expect(client.imageCalls).toHaveLength(3);
    expect(client.textCalls.length).toBeLessThanOrEqual(3);
    expect(client.textCalls).toHaveLength(1);
    expect(result.decisions).toMatchObject({ requests: 4, failed: 0 });
    expect(result.decisions!.cost).toBeCloseTo(3 * 0.0001188 + 0.00002, 9);

    const block = fs.readFileSync(result.proofBlockPath, 'utf8');
    expect(block).toMatch(/\*\*Claim check \(advisory\)\*\*/);
    expect(block).toContain('Claim: `');
    expect(block).toContain('claim.md` · routes: `/`, `/a` · role: anonymous');
    expect(block).toContain('Overall: satisfied');
    expect(block).toContain('- Alpha shows a total: satisfied, 0.90');
    expect(block).toContain('Advisory — reviewer decides.');
    expect(block.trimEnd().split('\n').at(-1)).toMatch(/^decisions: 4 requests, \d+ ms, \$0\.000\d{3}$/);

    // The caption sits between the still and its status line.
    const aImg = block.indexOf('<img src="');
    const caption = block.indexOf('_', aImg);
    expect(caption).toBeGreaterThan(aImg);
    expect(result.routes[0]!.caption).toBeTruthy();
    expect(block).toContain(`_${result.routes[0]!.caption!.replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`)}_`);

    // The claim and what the model saw: the sidecar text, not index.jsonl.
    const claimCall = client.calls.find((c) => 'reason0' in c.questions)!;
    expect(claimCall.model).toBe(config.decisions.models.triage);
    expect((claimCall.state as Array<{ type?: string }>).filter((p) => p.type === 'image_url')).toHaveLength(2);
    const claimState = JSON.parse((claimCall.state as string[])[0]!) as { pages: Array<{ route: string; visibleText: string }> };
    expect(claimState.pages.find((p) => p.route === '/a')!.visibleText).toBe('Alpha page total 12');
    expect(fs.readFileSync(path.join(dirs.scratchDir, 'index.jsonl'), 'utf8')).not.toContain('Alpha page total');
    expect(result.claim!.verdict).toBe('satisfied');
  });

  it('a claim that is not visible is advice, never a failure', async () => {
    configure({ enabled: true, captions: false, triage: 'off' });
    edit('src/pages/A.vue');
    await frame('/a');
    write(dirs.statusDir, 'claim.md', 'The dashboard has a dark mode toggle.');
    const result = await finish(scripted({ noulP: 0.02 }));
    expect(result.ok).toBe(true);
    expect(result.claim).toMatchObject({ verdict: 'not visible', criteria: [{ result: 'not visible', probability: 0.02 }] });
    expect(fs.readFileSync(result.proofBlockPath, 'utf8')).toContain('Overall: not visible');
  });

  it('skips the claim with a note when there is no claim file; claimFile moves it', async () => {
    configure({ enabled: true, captions: false, triage: 'off' });
    edit('src/pages/A.vue');
    await frame('/a');
    const none = await finish(scripted());
    expect(none.claim).toBeUndefined();
    expect(none.notes.some((n) => n.startsWith('claim check skipped: no claim at ') && n.endsWith('claim.md (write the claim there, or set claimFile)'))).toBe(true);

    configure({ enabled: true, captions: false, triage: 'off' }, { claimFile: 'docs/claim.md' });
    write(repo, 'docs/claim.md', '- Alpha shows a total\n');
    const moved = await finish(scripted());
    expect(moved.claim?.source).toBe('docs/claim.md');
  });

  it('verdict:false and captions:false send neither', async () => {
    configure({ enabled: true, verdict: false, captions: false, triage: 'off' });
    edit('src/pages/A.vue');
    await frame('/a');
    write(dirs.statusDir, 'claim.md', '- x\n');
    const client = scripted();
    const result = await finish(client);
    expect(client.calls).toHaveLength(0);
    expect(result.claim).toBeUndefined();
    expect(result.routes[0]!.caption).toBeUndefined();
  });

  it('budget exhaustion: unfinished decisions are skipped with notes, finish still passes, and returns near the budget', async () => {
    configure({ enabled: true, budgetMs: 300, triage: 'fail' });
    edit('src/pages/A.vue');
    await frame('/a');
    write(dirs.statusDir, 'claim.md', '- x\n');
    const client = new FakeClient(hang); // a provider that never answers
    const t0 = Date.now();
    const result = await finish(client);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2500);
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.routes[0]!.imageCheck).toMatchObject({ label: 'unknown', note: 'skipped: decision budget exhausted' });
    expect(result.routes[0]!.caption).toBeTruthy(); // the first template
    expect(result.notes).toContain('image check unknown for /a: skipped: decision budget exhausted');
    expect(result.notes).toContain('decisions: unfinished work was skipped at the 300 ms budget');
    expect(result.notes.some((n) => n.startsWith('claim check: skipped'))).toBe(true);
    expect(result.notes.some((n) => n.startsWith('captions use templates'))).toBe(true);
    expect(result.decisions!.requests).toBe(3);
    expect(result.decisions!.ms).toBeGreaterThanOrEqual(250);
    expect(result.decisions!.ms).toBeLessThan(1500);
  });

  it('shares the budget with the prune phase: the clock only runs inside decision phases', async () => {
    configure({ enabled: true, budgetMs: 400, triage: 'warn', verdict: false });
    edit('src/pages/A.vue');
    await frame('/a');
    const rt = new DecisionRuntime({ config: config.decisions, env: {}, configDir: repo, client: scripted() });
    await rt.phase(async () => new Promise((r) => setTimeout(r, 150)));
    await new Promise((r) => setTimeout(r, 400)); // waiting outside a phase costs nothing
    expect(rt.exhausted).toBe(false);
    await rt.phase(async (budget) => expect(budget.remainingMs()).toBeLessThanOrEqual(250));
    expect(rt.ms).toBeGreaterThanOrEqual(150);
  });
});

describe('route pruning at finish', () => {
  const KEYS = Array.from({ length: 8 }, (_, i) => `/p${i}`);
  const WIDE = (() => {
    const entries: Record<string, string[]> = { 'src/shared/Badge.vue': KEYS };
    KEYS.forEach((k, i) => (entries[`src/pages/P${i}.vue`] = [k]));
    return graph(entries);
  })();

  beforeEach(() => {
    // The wide fixture belongs to the base branch, so only the badge edit below is "changed".
    git(repo, 'checkout', '-q', 'main');
    write(repo, 'src/shared/Badge.vue', '<template>badge</template>\n');
    for (let i = 0; i < 8; i++) write(repo, `src/pages/P${i}.vue`, `<template>p${i}</template>\n`);
    commitAll(repo, 'wide fixture');
    git(repo, 'checkout', '-q', 'work');
    git(repo, 'reset', '-q', '--hard', 'main');
  });

  const run = (extra: Parameters<typeof runFinish>[1] = {}) => runFinish(config, { dirs, env: {}, buildGraph: async () => WIDE, ...extra });

  it('expects only the routes the watcher kept (its cached decision), so pruned routes need no frame', async () => {
    configure({ enabled: true, verdict: false, captions: false, triage: 'off' });
    edit('src/shared/Badge.vue');
    // The watcher saw the save, asked once and captured only the kept routes.
    const watchClient = new FakeClient((req) =>
      okResult(Object.fromEntries(Object.keys(req.questions).map((id) => [id, noul(Number(id.slice(1)) < 4 ? 0.9 : 0.05)]))),
    );
    const res = resolveRoutes(['src/shared/Badge.vue'], WIDE, { appUrl: config.appUrl, staticRoutes: {}, routeParams: {} });
    const kept = await pruneForWatch(config, new DecisionRuntime({ config: config.decisions, env: {}, configDir: repo, client: watchClient }), dirs.statusDir, ['src/shared/Badge.vue'], res, WIDE, null);
    expect(kept.routes.map((r) => r.routeKey)).toEqual(['/p0', '/p1', '/p2', '/p3']);
    for (const r of kept.routes) await frame(r.path);

    const finishClient = scripted();
    const result = await run({ decisionsClient: finishClient });
    expect(finishClient.calls).toHaveLength(0); // the cached decision answers
    expect(result.failures).toEqual([]);
    expect(result.routes.map((r) => r.route)).toEqual(['/p0', '/p1', '/p2', '/p3']);
    expect(result.notes.some((n) => n.startsWith('pruned 4 of 8 route(s) for src/shared/Badge.vue'))).toBe(true);

    // Even with decisions off at finish, the same set is expected.
    const off = await run();
    expect(off.failures).toEqual([]);
    expect(off.routes).toHaveLength(4);
  });

  it('with no cached decision and no key, every route is expected', async () => {
    configure({ enabled: true, verdict: false, captions: false, triage: 'off' });
    edit('src/shared/Badge.vue');
    for (const k of KEYS.slice(0, 4)) await frame(k);
    const result = await run();
    expect(result.failures).toEqual(KEYS.slice(4).map((k) => `no frame at HEAD for ${k}`));
  });

  it('prunes at finish when the watcher did not (request counted in the footer)', async () => {
    configure({ enabled: true, verdict: false, captions: false, triage: 'off' });
    edit('src/shared/Badge.vue');
    for (const k of KEYS.slice(0, 4)) await frame(k);
    const client = new FakeClient((req) =>
      okResult(Object.fromEntries(Object.keys(req.questions).map((id) => [id, noul(Number(id.slice(1)) < 4 ? 0.9 : 0.05)]))),
    );
    const result = await run({ decisionsClient: client });
    expect(result.failures).toEqual([]);
    expect(client.calls).toHaveLength(1);
    expect(result.decisions?.requests).toBe(1);
  });
});
