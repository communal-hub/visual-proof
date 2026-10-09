import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { EXIT } from '../../src/exit.js';
import { closestKeys, listing, paramsCommand, unknownKeyMessage, type ParamsAction } from '../../src/params.js';
import { statusFiles, type Dirs } from '../../src/paths.js';
import type { ImportGraph } from '../../src/resolve/import-graph.js';
import { writeDiscoveryCache } from '../../src/resolve/param-discovery.js';
import { readSessionParams, setSessionParams } from '../../src/resolve/session-params.js';
import { Timeline } from '../../src/timeline.js';
import { tmpDir } from './helpers.js';

const ROUTES = ['/', '/manage/invoices', '/manage/invoices/new', '/manage/invoices/:id', '/manage/clubs/:clubId/teams/:teamId', '/users/:id(\\d+)', '/docs/:slug?'];
const graph: ImportGraph = {
  fileToRoutes: new Map(),
  routes: ROUTES.map((p) => ({ path: p, routeFile: 'src/router.js', component: null, layouts: [], dynamic: false })),
  unresolved: [],
};

let repo: string;
let dirs: Dirs;
let env: NodeJS.ProcessEnv;
let files: ReturnType<typeof statusFiles>;
let out: string;
let err: string;

beforeEach(() => {
  repo = tmpDir('vp-params-repo-');
  fs.writeFileSync(path.join(repo, 'visual-proof.config.json'), JSON.stringify({ appUrl: 'http://localhost:1', staticRoutes: { 'src/x.vue': ['/static/:slug'] } }));
  const root = tmpDir('vp-params-status-');
  dirs = { statusDir: path.join(root, 'status'), artifactDir: path.join(root, 'artifacts'), scratchDir: path.join(root, 'status/scratch') };
  env = { VISUAL_PROOF_STATUS_DIR: dirs.statusDir, VISUAL_PROOF_ARTIFACT_DIR: dirs.artifactDir };
  files = statusFiles(dirs);
  out = '';
  err = '';
});

function run(action: ParamsAction, args: string[], extra: Partial<Parameters<typeof paramsCommand>[0]> = {}): Promise<number> {
  return paramsCommand({
    action,
    args,
    json: false,
    env,
    cwd: repo,
    out: (t) => (out += t),
    err: (t) => (err += t),
    buildGraph: async (_c: Config) => graph,
    pollMs: 10,
    ...extra,
  });
}

describe('params set: validation (exit 2)', () => {
  it('exits 2 for an unknown route key and suggests the closest keys', async () => {
    expect(await run('set', ['/manage/invoice/:id', 'id=1'])).toBe(EXIT.USAGE);
    expect(err).toContain('"/manage/invoice/:id" is not a known route key');
    expect(err).toContain('closest route keys: /manage/invoices/:id');
    expect(fs.existsSync(files.sessionParams)).toBe(false);
  });

  it('points a concrete path at its route key', async () => {
    expect(await run('set', ['/manage/invoices/5', 'id=5'])).toBe(EXIT.USAGE);
    expect(err).toContain("that path fits /manage/invoices/:id; use the route key: params set '/manage/invoices/:id' id=5");
  });

  it('knows the staticRoutes keys too', async () => {
    expect(await run('set', ['/static/:slug', 'slug=a'])).toBe(EXIT.OK);
    expect(readSessionParams(files.sessionParams).routes['/static/:slug']).toMatchObject({ path: '/static/a' });
  });

  it('exits 2 for missing params, naming them and showing the usage', async () => {
    expect(await run('set', ['/manage/clubs/:clubId/teams/:teamId', 'clubId=1'])).toBe(EXIT.USAGE);
    expect(err).toContain('needs teamId');
    expect(err).toContain("usage: params set '/manage/clubs/:clubId/teams/:teamId' clubId=<value> teamId=<value>");
  });

  it('exits 2 for extra params', async () => {
    expect(await run('set', ['/manage/invoices/:id', 'id=1', 'slug=x'])).toBe(EXIT.USAGE);
    expect(err).toContain('has no param slug');
  });

  it('exits 2 for a value that does not fit the route (custom regex, slash)', async () => {
    expect(await run('set', ['/users/:id(\\d+)', 'id=abc'])).toBe(EXIT.USAGE);
    expect(err).toContain('id="abc" does not fit (\\d+)');
    err = '';
    expect(await run('set', ['/manage/invoices/:id', 'id=a/b'])).toBe(EXIT.USAGE);
    expect(err).toContain('must not contain "/"');
  });

  it('exits 2 for a route with no params, a malformed assignment, a repeated param, or no key', async () => {
    expect(await run('set', ['/manage/invoices', 'id=1'])).toBe(EXIT.USAGE);
    expect(err).toContain('has no params to set');
    err = '';
    expect(await run('set', ['/manage/invoices/:id', 'id'])).toBe(EXIT.USAGE);
    expect(err).toContain('"id" is not param=value');
    err = '';
    expect(await run('set', ['/manage/invoices/:id', 'id=1', 'id=2'])).toBe(EXIT.USAGE);
    expect(err).toContain('id is given twice');
    err = '';
    expect(await run('set', [])).toBe(EXIT.USAGE);
    expect(fs.existsSync(files.sessionParams)).toBe(false);
  });

  it('exits 3 when the config is invalid, and does not need the graph', async () => {
    fs.writeFileSync(path.join(repo, 'visual-proof.config.json'), JSON.stringify({ appUrl: 'http://localhost:1', paramDiscovery: 'sometimes' }));
    expect(await run('set', ['/manage/invoices/:id', 'id=1'])).toBe(EXIT.SETUP);
    expect(err).toContain('"paramDiscovery" must be "links" or "off"');
  });
});

describe('params set: storing and the watcher', () => {
  it('stores the params and the built path; with no watcher it says nothing was captured and exits 0', async () => {
    expect(await run('set', ['/manage/invoices/:id', 'id=5'])).toBe(EXIT.OK);
    expect(out).toBe('session params set: /manage/invoices/:id -> /manage/invoices/5\n');
    expect(err).toContain('no watcher is running');
    expect(readSessionParams(files.sessionParams)).toMatchObject({
      rev: 1,
      routes: { '/manage/invoices/:id': { path: '/manage/invoices/5', params: { id: '5' } } },
    });
  });

  it('accepts optional params left out, and replaces an earlier set', async () => {
    expect(await run('set', ['/docs/:slug?', 'slug=intro'])).toBe(EXIT.OK);
    expect(await run('set', ['/manage/invoices/:id', 'id=1'])).toBe(EXIT.OK);
    expect(await run('set', ['/manage/invoices/:id', 'id=2'])).toBe(EXIT.OK);
    const read = readSessionParams(files.sessionParams);
    expect(read.rev).toBe(3);
    expect(read.routes['/manage/invoices/:id']!.path).toBe('/manage/invoices/2');
  });

  /** A status.json that says a watcher (this process) is ready, like the daemon writes it. */
  function liveWatcher(extra: Record<string, unknown> = {}): void {
    fs.mkdirSync(dirs.statusDir, { recursive: true });
    fs.writeFileSync(files.status, JSON.stringify({ state: 'ready', sessionId: 's-1', pid: process.pid, sessionParamsRev: 0, ...extra }));
  }
  const frame = (status: 'clean' | 'error', route = '/manage/invoices/5'): void => {
    new Timeline(dirs.scratchDir, 200).append(
      { sessionId: 's-1', route, routeKey: '/manage/invoices/:id', at: new Date(Date.now() + 5000).toISOString(), treeHash: 'a'.repeat(40), trigger: 'params', status, reasons: status === 'clean' ? [] : ['console error: boom'], paramsFrom: 'session' },
      Buffer.from('png'),
    );
  };

  it('waits for the watcher to confirm, then reports the frame (exit 0 when clean)', async () => {
    liveWatcher();
    const command = run('set', ['/manage/invoices/:id', 'id=5']);
    setTimeout(() => {
      frame('clean');
      liveWatcher({ sessionParamsRev: 1 });
    }, 80);
    expect(await command).toBe(EXIT.OK);
    expect(out).toContain('captured /manage/invoices/5: clean (frame f-000001, tree aaaaaaaa)');
  });

  it('exits 1 when the captured frame is not clean', async () => {
    liveWatcher();
    const command = run('set', ['/manage/invoices/:id', 'id=5']);
    setTimeout(() => {
      frame('error');
      liveWatcher({ sessionParamsRev: 1 });
    }, 50);
    expect(await command).toBe(EXIT.FAILURES);
    expect(out).toContain('captured /manage/invoices/5: error');
    expect(err).toContain('is error: console error: boom; check the id');
  });

  it('exits 1 when the watcher never confirms within --timeout, or handles the change without a frame', async () => {
    liveWatcher();
    expect(await run('set', ['/manage/invoices/:id', 'id=5'], { timeoutSec: 0.2 })).toBe(EXIT.FAILURES);
    expect(err).toContain('did not confirm a capture of /manage/invoices/5 within 0.2 s');

    err = '';
    liveWatcher({ sessionParamsRev: 99 });
    expect(await run('set', ['/manage/invoices/:id', 'id=6'])).toBe(EXIT.FAILURES);
    expect(err).toContain('took no frame of /manage/invoices/6');
  });

  it('exits 1 when the watcher dies while it waits', async () => {
    liveWatcher();
    const command = run('set', ['/manage/invoices/:id', 'id=5']);
    setTimeout(() => liveWatcher({ state: 'stopped' }), 50);
    expect(await command).toBe(EXIT.FAILURES);
    expect(err).toContain('the watcher stopped before it captured the route');
  });
});

describe('params clear', () => {
  const entry = (p: string) => ({ path: p, params: { id: '1' }, at: 'now' });

  it('clears one route or all of them', async () => {
    setSessionParams(files.sessionParams, '/manage/invoices/:id', entry('/manage/invoices/1'));
    setSessionParams(files.sessionParams, '/users/:id(\\d+)', entry('/users/1'));
    expect(await run('clear', ['/users/:id(\\d+)'])).toBe(EXIT.OK);
    expect(out).toBe('cleared session params for /users/:id(\\d+)\n');
    expect(Object.keys(readSessionParams(files.sessionParams).routes)).toEqual(['/manage/invoices/:id']);
    out = '';
    expect(await run('clear', [])).toBe(EXIT.OK);
    expect(out).toBe('cleared session params for /manage/invoices/:id\n');
    out = '';
    expect(await run('clear', [])).toBe(EXIT.OK);
    expect(out).toBe('no session params to clear\n');
  });

  it('a known route with nothing set is fine; an unknown route is exit 2 with suggestions', async () => {
    expect(await run('clear', ['/manage/invoices/:id'])).toBe(EXIT.OK);
    expect(out).toBe('no session params for /manage/invoices/:id\n');
    expect(await run('clear', ['/manage/invoice/:id'])).toBe(EXIT.USAGE);
    expect(err).toContain('closest route keys: /manage/invoices/:id');
  });

  it('clears a stale key that is no longer a route, without needing the config', async () => {
    setSessionParams(files.sessionParams, '/gone/:id', entry('/gone/1'));
    fs.rmSync(path.join(repo, 'visual-proof.config.json'));
    expect(await run('clear', ['/gone/:id'])).toBe(EXIT.OK);
    expect(readSessionParams(files.sessionParams).routes).toEqual({});
  });
});

describe('params list', () => {
  it('says so when there is nothing', async () => {
    expect(await run('list', [])).toBe(EXIT.OK);
    expect(out).toBe('no session or discovered params\n');
    out = '';
    expect(await run('list', [], { json: true })).toBe(EXIT.OK);
    expect(JSON.parse(out)).toMatchObject({ session: [], discovered: [], seedCandidates: [], files: { session: files.sessionParams, discovery: files.paramDiscovery } });
  });

  it('lists session params, this session\'s discoveries and the seed candidates (session wins over discovery)', async () => {
    setSessionParams(files.sessionParams, '/manage/invoices/:id', { path: '/manage/invoices/5', params: { id: '5' }, at: 'now' });
    fs.writeFileSync(files.status, JSON.stringify({ state: 'ready', sessionId: 's-now' }));
    writeDiscoveryCache(files.paramDiscovery, 's-now', {
      '/manage/invoices/:id': { path: '/manage/invoices/1', foundOn: '/manage/invoices', at: 'now' },
      '/manage/clubs/:clubId/teams/:teamId': { path: '/manage/clubs/1/teams/10', foundOn: '/manage/clubs/1/teams', at: 'now' },
    });
    const result = listing(dirs);
    expect(result.session.map((s) => s.routeKey)).toEqual(['/manage/invoices/:id']);
    expect(result.discovered.map((d) => d.routeKey)).toEqual(['/manage/clubs/:clubId/teams/:teamId']);
    expect(result.seedCandidates).toEqual([
      { routeKey: '/manage/clubs/:clubId/teams/:teamId', route: '/manage/clubs/1/teams/10', params: { clubId: '1', teamId: '10' }, paramsFrom: 'discovered', foundOn: '/manage/clubs/1/teams' },
      { routeKey: '/manage/invoices/:id', route: '/manage/invoices/5', params: { id: '5' }, paramsFrom: 'session' },
    ]);

    expect(await run('list', [])).toBe(EXIT.OK);
    expect(out).toContain('session params');
    expect(out).toContain('/manage/invoices/:id -> /manage/invoices/5  (id=5)');
    expect(out).toContain('/manage/clubs/:clubId/teams/:teamId -> /manage/clubs/1/teams/10  (found on /manage/clubs/1/teams)');
    expect(out).toContain('seed candidates');
    expect(out).toContain('/manage/invoices/:id  id=5  (session)');
  });

  it('ignores discoveries from another watcher session', () => {
    fs.mkdirSync(dirs.statusDir, { recursive: true });
    fs.writeFileSync(files.status, JSON.stringify({ state: 'ready', sessionId: 's-now' }));
    writeDiscoveryCache(files.paramDiscovery, 's-old', { '/a/:id': { path: '/a/1', foundOn: '/a', at: 'now' } });
    expect(listing(dirs).discovered).toEqual([]);
  });

  it('prints a broken session file as a warning', async () => {
    fs.mkdirSync(dirs.statusDir, { recursive: true });
    fs.writeFileSync(files.sessionParams, '{ nope');
    expect(await run('list', [])).toBe(EXIT.OK);
    expect(out).toContain('warning: session params file is not valid JSON');
  });
});

describe('suggestions', () => {
  it('ranks keys by edit distance', () => {
    expect(closestKeys('/manage/invoice/:id', ROUTES, 2)).toEqual(['/manage/invoices/:id', '/manage/invoices']);
    expect(closestKeys('/MANAGE/INVOICES/:ID', ROUTES, 1)).toEqual(['/manage/invoices/:id']);
  });

  it('says so when the route table is empty', () => {
    expect(unknownKeyMessage('/x/:id', [])).toContain('the route table is empty');
  });
});
