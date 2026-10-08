import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, type Config } from '../../src/config.js';
import { doctorCommand, formatReport, runDoctor, type DoctorOptions, type DoctorReport, type Probes } from '../../src/doctor.js';
import type { Dirs } from '../../src/paths.js';
import type { ImportGraph } from '../../src/resolve/import-graph.js';
import { commitAll, initRepo, tmpDir, write } from './helpers.js';

let repo: string;
let dirs: Dirs;
let env: NodeJS.ProcessEnv;

const graph = (routes: number, files = routes * 2, unresolved = 0): ImportGraph => ({
  fileToRoutes: new Map(Array.from({ length: files }, (_, i) => [`src/f${i}.vue`, ['/x']] as [string, string[]])),
  routes: Array.from({ length: routes }, (_, i) => ({
    path: `/r${i}`,
    routeFile: 'src/router.js',
    component: null,
    layouts: [],
    dynamic: false,
  })),
  unresolved: Array.from({ length: unresolved }, (_, i) => `note ${i}`),
});

const greenProbes = (): Probes => ({
  launchBrowser: async () => '130.0.1',
  connectHmr: async () => true,
  login: async () => ({ status: 204 }),
  buildGraph: async () => graph(3, 5, 1),
  getJson: async (_config, paths) => paths.map(() => ({ status: 200, json: [] })),
});

function configure(extra: Record<string, unknown> = {}): Config {
  return parseConfig(
    {
      appUrl: 'http://localhost:1',
      freshnessMarker: '.hot',
      screenGlobs: ['src/**/*.vue'],
      backendGlobs: ['server/**'],
      login: { type: 'http-hook', url: '/login', email: 'a@b.test' },
      ...extra,
    },
    repo,
    {},
  );
}

const doctor = (config: Config | ConfigError, options: DoctorOptions = {}) =>
  runDoctor(config, { dirs, ...options, probes: { ...greenProbes(), ...options.probes } });

beforeEach(() => {
  repo = initRepo();
  write(repo, 'src/A.vue', 'a');
  write(repo, 'src/deep/B.vue', 'b');
  write(repo, 'src/notes.txt', 'n');
  write(repo, 'node_modules/pkg/C.vue', 'ignored');
  write(repo, 'server/data.json', '{}');
  write(repo, '.hot', 'x');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  commitAll(repo);
  const root = tmpDir('vp-doctor-');
  dirs = { statusDir: path.join(root, 'status'), artifactDir: path.join(root, 'artifacts'), scratchDir: path.join(root, 'status/scratch') };
  env = { VISUAL_PROOF_STATUS_DIR: dirs.statusDir, VISUAL_PROOF_ARTIFACT_DIR: dirs.artifactDir };
});

describe('runDoctor', () => {
  it('reports every capability, writes doctor.json, and is ok when all probes pass', async () => {
    const report = await doctor(configure());
    expect(report.ok).toBe(true);
    expect(Object.keys(report.capabilities)).toEqual(['config', 'git', 'browser', 'trigger', 'barrier', 'freshness', 'login', 'routes', 'params', 'paramTiers', 'renderCheck']);
    expect(report.capabilities).toMatchObject({
      config: { tier: 'valid', status: 'ok' },
      git: { tier: 'repo', status: 'ok' },
      browser: { tier: 'chromium', status: 'ok', required: true },
      trigger: { tier: 'fs-watch', status: 'ok', required: true, detail: '2 screen file(s), 1 backend file(s) match the globs' },
      barrier: { tier: 'vite-hmr', status: 'ok', required: false },
      freshness: { tier: 'marker', status: 'ok' },
      login: { tier: 'http-hook', status: 'ok' },
      routes: { tier: 'import-graph', status: 'ok', detail: '3 route(s), 5 file(s) mapped, 1 unresolved' },
      params: { tier: 'none', status: 'ok', required: false },
    });
    expect(report.capabilities.git.detail).toMatch(/^HEAD tree [0-9a-f]{8}$/);
    expect(JSON.parse(fs.readFileSync(path.join(dirs.statusDir, 'doctor.json'), 'utf8'))).toEqual(report);
  });

  it('browser missing is required and fails the run, without stopping the other probes', async () => {
    const report = await doctor(configure(), {
      probes: { launchBrowser: async () => Promise.reject(new Error("Executable doesn't exist at /x/chrome")) },
    });
    expect(report.ok).toBe(false);
    expect(report.capabilities.browser).toMatchObject({ tier: 'none', status: 'missing', required: true });
    expect(report.capabilities.browser.detail).toContain("Executable doesn't exist");
    expect(report.capabilities.barrier.status).toBe('ok');
  });

  it('zero screen matches makes the trigger missing and fails the run', async () => {
    const report = await doctor(configure({ screenGlobs: ['nothing/**/*.vue'] }));
    expect(report.ok).toBe(false);
    expect(report.capabilities.trigger).toMatchObject({ tier: 'fs-watch', status: 'missing', required: true });
    expect(report.capabilities.trigger.detail).toContain('no files match screenGlobs');
  });

  it('backend-only matches do not rescue a trigger with no screen files', async () => {
    const report = await doctor(configure({ screenGlobs: ['nothing/**'], backendGlobs: ['server/**'] }));
    expect(report.capabilities.trigger.status).toBe('missing');
    expect(report.capabilities.trigger.detail).toContain('1 backend file(s)');
  });

  it('globs with a non-directory base (**/*.vue) scan the repo but skip node_modules', async () => {
    const report = await doctor(configure({ screenGlobs: ['**/*.vue'], backendGlobs: [] }));
    expect(report.capabilities.trigger.detail).toBe('2 screen file(s), 0 backend file(s) match the globs');
  });

  it.each([
    ['not connected', async () => false],
    ['connection error', async () => Promise.reject(new Error('ECONNREFUSED'))],
  ])('barrier falls back to timeout-only on %s, without failing the run', async (_name, connectHmr) => {
    const report = await doctor(configure(), { probes: { connectHmr } });
    expect(report.ok).toBe(true);
    expect(report.capabilities.barrier).toMatchObject({ tier: 'timeout-only', status: 'warn', required: false });
  });

  it('login: 2xx is http-hook, other statuses and errors are "failed" warnings, none is none', async () => {
    const non2xx = await doctor(configure(), { probes: { login: async () => ({ status: 403 }) } });
    expect(non2xx.ok).toBe(true);
    expect(non2xx.capabilities.login).toMatchObject({ tier: 'failed', status: 'warn', detail: 'POST /login -> HTTP 403' });

    const refused = await doctor(configure(), { probes: { login: async () => Promise.reject(new Error('connect ECONNREFUSED')) } });
    expect(refused.capabilities.login).toMatchObject({ tier: 'failed', status: 'warn' });
    expect(refused.capabilities.login.detail).toContain('ECONNREFUSED');

    const none = await doctor(configure({ login: { type: 'none' } }));
    expect(none.capabilities.login).toMatchObject({ tier: 'none', status: 'ok' });
  });

  it('freshness: present, missing, not configured', async () => {
    expect((await doctor(configure())).capabilities.freshness).toMatchObject({ tier: 'marker', status: 'ok' });
    fs.rmSync(path.join(repo, '.hot'));
    expect((await doctor(configure())).capabilities.freshness).toMatchObject({ tier: 'marker-missing', status: 'warn' });
    const unconfigured = configure();
    delete unconfigured.freshnessMarker;
    expect((await doctor(unconfigured)).capabilities.freshness).toMatchObject({ tier: 'none', status: 'ok' });
  });

  describe('renderCheck', () => {
    it('reports the mode of the rendered-component check, never required', async () => {
      expect((await doctor(configure())).capabilities.renderCheck).toMatchObject({ tier: 'fail', status: 'ok', required: false });
      expect((await doctor(configure({ renderCheck: 'warn' }))).capabilities.renderCheck).toMatchObject({ tier: 'warn', status: 'warn' });
      expect((await doctor(configure({ renderCheck: 'off' }))).capabilities.renderCheck).toMatchObject({ tier: 'off', status: 'warn', required: false });
    });
  });

  describe('params', () => {
    const seedFile = '.visual-proof/params.json';

    it('is none without routeParams or a file, config with routeParams', async () => {
      expect((await doctor(configure())).capabilities.params).toMatchObject({ tier: 'none', status: 'ok', required: false });
      expect((await doctor(configure({ routeParams: { '/a/:id': '/a/1' } }))).capabilities.params).toMatchObject({
        tier: 'config',
        status: 'ok',
        detail: '1 entry',
      });
    });

    it('is seed-file when the file is present, counting its entries', async () => {
      write(repo, seedFile, JSON.stringify({ routes: { '/a/:id': '/a/1', '/b/:id': '/b/2' } }));
      const report = await doctor(configure({ routeParamsFile: seedFile, routeParams: { '/c/:id': '/c/3' } }));
      expect(report.capabilities.params).toMatchObject({
        tier: 'seed-file',
        status: 'ok',
        required: false,
        detail: `2 entries from ${seedFile}`,
      });
    });

    it('warns "routeParamsFile not found" and falls back to the config tier when the file is missing', async () => {
      const report = await doctor(configure({ routeParamsFile: seedFile, routeParams: { '/c/:id': '/c/3' } }));
      expect(report.capabilities.params).toMatchObject({ tier: 'config', status: 'warn', required: false });
      expect(report.capabilities.params.detail).toContain(`routeParamsFile not found: ${path.join(repo, seedFile)}`);
      expect(report.ok).toBe(true);
    });

    it('reports invalid JSON and a wrong shape as errors without failing the run', async () => {
      write(repo, seedFile, '{ nope');
      const bad = await doctor(configure({ routeParamsFile: seedFile }));
      expect(bad.capabilities.params).toMatchObject({ tier: 'invalid', status: 'missing', required: false });
      expect(bad.capabilities.params.detail).toContain('is not valid JSON');
      expect(bad.ok).toBe(true);

      write(repo, seedFile, '[1]');
      const shape = await doctor(configure({ routeParamsFile: seedFile }));
      expect(shape.capabilities.params.detail).toContain('has the wrong shape');
    });

    it('warns about ignored values but still counts the valid entries', async () => {
      write(repo, seedFile, JSON.stringify({ '/a/:id': '/a/1', '/b/:id': 7 }));
      const report = await doctor(configure({ routeParamsFile: seedFile }));
      expect(report.capabilities.params).toMatchObject({ tier: 'seed-file', status: 'warn' });
      expect(report.capabilities.params.detail).toContain(`1 entry from ${seedFile}`);
      expect(report.capabilities.params.detail).toContain('"/b/:id" ignored');
    });
  });

  it('routes: import-graph, static-map fallback, none', async () => {
    const empty = { buildGraph: async () => graph(0) };
    const staticMap = await doctor(configure({ staticRoutes: { 'src/A.vue': ['/a'] } }), { probes: empty });
    expect(staticMap.capabilities.routes).toMatchObject({ tier: 'static-map', status: 'warn' });
    expect(staticMap.capabilities.routes.detail).toContain('1 file(s) mapped in staticRoutes');

    const none = await doctor(configure(), { probes: empty });
    expect(none.capabilities.routes).toMatchObject({ tier: 'none', status: 'warn' });

    const broken = await doctor(configure({ staticRoutes: { 'src/A.vue': ['/a'] } }), {
      probes: { buildGraph: async () => Promise.reject(new Error('bad router')) },
    });
    expect(broken.capabilities.routes).toMatchObject({ tier: 'static-map' });
    expect(broken.capabilities.routes.detail).toContain('import graph failed: bad router');
    expect(broken.ok).toBe(true);
  });

  it('git: no repo and no commits are reported, never fatal', async () => {
    const bare = tmpDir('vp-bare-');
    write(bare, 'src/A.vue', 'a');
    const config = parseConfig({ appUrl: 'http://localhost:1' }, bare, {});
    const noRepo = await doctor(config);
    expect(noRepo.capabilities.git).toMatchObject({ tier: 'none', status: 'missing', required: false });
    expect(noRepo.ok).toBe(true);

    const fresh = initRepo();
    write(fresh, 'src/A.vue', 'a');
    const noCommits = await doctor(parseConfig({ appUrl: 'http://localhost:1' }, fresh, {}));
    expect(noCommits.capabilities.git).toMatchObject({ tier: 'repo', status: 'warn' });
  });

  it('an invalid config reports it, marks the trigger missing, still probes the browser', async () => {
    const report = await doctor(new ConfigError('visual-proof.config.json: invalid config\n  - "appUrl" is required'));
    expect(report.ok).toBe(false);
    expect(report.capabilities.config).toMatchObject({ tier: 'invalid', status: 'missing' });
    expect(report.capabilities.config.detail).toBe('visual-proof.config.json: invalid config; "appUrl" is required');
    expect(report.capabilities.trigger).toMatchObject({ status: 'missing', required: true });
    expect(report.capabilities.browser.status).toBe('ok');
    expect(report.capabilities.barrier.status).toBe('skipped');
  });

  it('bounds hung probes by their timeouts', async () => {
    const hang = () => new Promise<never>(() => {});
    const t0 = Date.now();
    const report = await doctor(configure(), {
      probes: { launchBrowser: hang, connectHmr: hang, login: hang, buildGraph: hang },
      timeouts: { browserMs: 100, barrierMs: 100, loginMs: 100, routesMs: 100 },
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(report.capabilities.browser.detail).toContain('timed out');
    expect(report.capabilities.barrier.tier).toBe('timeout-only');
    expect(report.capabilities.login.tier).toBe('failed');
    expect(report.capabilities.routes.detail).toContain('timed out');
    expect(report.ok).toBe(false);
  });
});

describe('real probes against a down app', () => {
  it('finishes well under 10 s: barrier timeout-only, login failed, exit still decided by browser and trigger', async () => {
    // A port nothing listens on.
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    await new Promise((r) => server.close(r));

    const config = configure({ appUrl: `http://127.0.0.1:${port}`, viteUrl: `http://127.0.0.1:${port}` });
    const t0 = Date.now();
    const report = await runDoctor(config, {
      dirs,
      probes: { launchBrowser: async () => '1.0' },
      timeouts: { barrierMs: 1500, loginMs: 1500 },
    });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(report.ok).toBe(true);
    expect(report.capabilities.barrier.tier).toBe('timeout-only');
    expect(report.capabilities.login).toMatchObject({ tier: 'failed', status: 'warn' });
    expect(report.capabilities.login.detail).toContain('ECONNREFUSED');
  });

  it('the login probe sends the token header and the email, and reads the token file', async () => {
    const seen: Array<{ token: string | undefined; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ token: req.headers['x-visual-proof-token'] as string | undefined, body });
        res.writeHead(req.headers['x-visual-proof-token'] === 'sekrit' ? 204 : 403).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      write(repo, '.vp/token', 'sekrit\n');
      const login = { type: 'http-hook', url: '/login', email: 'a@b.test', tokenFile: '.vp/token' };
      const ok = await runDoctor(configure({ appUrl: url, viteUrl: url, login }), { dirs, probes: { launchBrowser: async () => '1', connectHmr: async () => true } });
      expect(ok.capabilities.login).toMatchObject({ tier: 'http-hook', status: 'ok', detail: 'POST /login -> 204' });
      expect(seen[0]).toEqual({ token: 'sekrit', body: JSON.stringify({ email: 'a@b.test' }) });

      write(repo, '.vp/token', 'wrong\n');
      const bad = await runDoctor(configure({ appUrl: url, viteUrl: url, login }), { dirs, probes: { launchBrowser: async () => '1', connectHmr: async () => true } });
      expect(bad.capabilities.login).toMatchObject({ tier: 'failed', detail: 'POST /login -> HTTP 403' });

      fs.rmSync(path.join(repo, '.vp/token'));
      const missing = await runDoctor(configure({ appUrl: url, viteUrl: url, login }), { dirs, probes: { launchBrowser: async () => '1', connectHmr: async () => true } });
      expect(missing.capabilities.login.detail).toContain('cannot read token file .vp/token (ENOENT)');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('paramTiers', () => {
  const keys = ['/a/:id', '/b/:id', '/c/:id', '/d/:id', '/plain'];
  const withKeys = (): Probes['buildGraph'] => async () => ({
    ...graph(0),
    routes: keys.map((path) => ({ path, routeFile: 'src/router.js', component: null, layouts: [], dynamic: false })),
  });
  const seedFile = '.visual-proof/params.json';

  it('counts the routes with params each tier covers: config, seed-file, list-endpoint, uncovered', async () => {
    write(repo, seedFile, JSON.stringify({ '/b/:id': '/b/9' }));
    const report = await doctor(
      configure({
        routeParams: { '/a/:id': '/a/1', '/b/:id': '/b/1' },
        routeParamsFile: seedFile,
        paramSources: { '/c/:id': { url: '/api/c', pick: '0.id' } },
      }),
      { probes: { buildGraph: withKeys(), getJson: async () => [{ status: 200, json: [{ id: 5 }] }] } },
    );
    expect(report.capabilities.paramTiers).toMatchObject({ tier: 'list-endpoint', status: 'warn', required: false });
    expect(report.capabilities.paramTiers.detail).toContain('4 route(s) with params: config 1, seed-file 1, list-endpoint 1, uncovered 1');
    expect(report.capabilities.paramTiers.detail).toContain('uncovered: /d/:id');
    expect(report.capabilities.paramTiers.detail).toContain('probe /api/c -> /c/5');
    expect(report.ok).toBe(true);
  });

  it('is ok and tier none when every param route is covered and no source is configured, without probing', async () => {
    let probed = false;
    const report = await doctor(
      configure({ routeParams: { '/a/:id': '/a/1', '/b/:id': '/b/1', '/c/:id': '/c/1', '/d/:id': '/d/1' } }),
      {
        probes: {
          buildGraph: withKeys(),
          getJson: async () => {
            probed = true;
            return [];
          },
        },
      },
    );
    expect(report.capabilities.paramTiers).toMatchObject({ tier: 'none', status: 'ok' });
    expect(report.capabilities.paramTiers.detail).toBe('4 route(s) with params: config 4, seed-file 0, list-endpoint 0, uncovered 0');
    expect(probed).toBe(false);
  });

  it('probes every source once, in one call, with the source urls', async () => {
    const calls: string[][] = [];
    await doctor(
      configure({
        paramSources: {
          '/a/:id': { url: '/api/a', pick: '0.id' },
          '/b/:id': { url: '/api/b', pick: 'data.0.id' },
        },
      }),
      {
        probes: {
          buildGraph: withKeys(),
          getJson: async (_config, paths) => {
            calls.push(paths);
            return [{ status: 200, json: [{ id: 1 }] }, { status: 200, json: { data: [{ id: 2 }] } }];
          },
        },
      },
    );
    expect(calls).toEqual([['/api/a', '/api/b']]);
  });

  it('warns with the reason when a source answers with an error or the wrong shape', async () => {
    const report = await doctor(
      configure({
        paramSources: {
          '/a/:id': { url: '/api/a', pick: '0.id' },
          '/b/:id': { url: '/api/b', pick: '0.id' },
          '/c/:id': { url: '/api/c', pick: '0.id' },
        },
      }),
      {
        probes: {
          buildGraph: withKeys(),
          getJson: async () => [{ status: 500, error: 'HTTP 500' }, { status: 200, json: [] }, { status: 200, json: [{ id: 3 }] }],
        },
      },
    );
    const { status, detail } = report.capabilities.paramTiers;
    expect(status).toBe('warn');
    expect(detail).toContain('probe /api/a for /a/:id failed: HTTP 500');
    expect(detail).toMatch(/probe \/api\/b for \/b\/:id: the response has no index 0|probe \/api\/b for \/b\/:id: the response has 0 item/);
    expect(detail).toContain('probe /api/c -> /c/3');
    expect(report.ok).toBe(true);
  });

  it('says the sources were not probed when the app does not answer', async () => {
    const report = await doctor(configure({ paramSources: { '/a/:id': { url: '/api/a', pick: '0.id' } } }), {
      probes: { buildGraph: withKeys(), getJson: async () => [{ status: 0, error: 'connect ECONNREFUSED' }] },
    });
    expect(report.capabilities.paramTiers.status).toBe('warn');
    expect(report.capabilities.paramTiers.detail).toContain('paramSources not probed: app not reachable at http://localhost:1 (connect ECONNREFUSED)');
  });

  it('survives a probe that throws or never answers within the bound', async () => {
    const thrown = await doctor(configure({ paramSources: { '/a/:id': { url: '/api/a', pick: '0.id' } } }), {
      probes: { buildGraph: withKeys(), getJson: async () => Promise.reject(new Error('boom')) },
    });
    expect(thrown.capabilities.paramTiers.detail).toContain('paramSources not probed: boom');

    const t0 = Date.now();
    const hung = await doctor(configure({ paramSources: { '/a/:id': { url: '/api/a', pick: '0.id' } } }), {
      timeouts: { paramsMs: 200 },
      probes: { buildGraph: withKeys(), getJson: () => new Promise(() => {}) },
    });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(hung.capabilities.paramTiers.detail).toMatch(/not probed: paramSources probe timed out/);
  });

  it('flags a paramSources key that matches no route', async () => {
    const report = await doctor(configure({ paramSources: { '/zzz/:id': { url: '/api/z', pick: '0.id' } } }), {
      probes: { buildGraph: withKeys(), getJson: async () => [{ status: 200, json: [{ id: 1 }] }] },
    });
    expect(report.capabilities.paramTiers.detail).toContain('paramSources for no known route: /zzz/:id');
  });

  it('builds the import graph once for the routes and param tiers checks', async () => {
    let builds = 0;
    await doctor(configure(), {
      probes: {
        buildGraph: async () => {
          builds++;
          return graph(2);
        },
      },
    });
    expect(builds).toBe(1);
  });
});

describe('formatReport and doctorCommand', () => {
  it('prints one aligned row per capability', async () => {
    const text = formatReport(await doctor(configure({ screenGlobs: ['nothing/**'] })));
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(12);
    expect(lines[0]).toMatch(/^capability\s+tier\s+status\s+detail$/);
    expect(lines.find((l) => l.startsWith('trigger'))).toMatch(/^trigger\s+fs-watch\s+MISSING\s+no files match/);
    // Columns line up: every row's tier column starts at the same offset.
    const offset = lines[0]!.indexOf('tier');
    for (const line of lines.slice(1)) expect(line[offset - 1]).toBe(' ');
  });

  function writeConfig(extra: Record<string, unknown> = {}): string {
    const file = path.join(repo, 'visual-proof.config.json');
    fs.writeFileSync(file, JSON.stringify({ appUrl: 'http://localhost:1', screenGlobs: ['src/**/*.vue'], login: { type: 'none' }, ...extra }));
    return file;
  }
  async function run(configPath: string, options: DoctorOptions = {}) {
    let stdout = '';
    let stderr = '';
    const code = await doctorCommand({
      configPath,
      env,
      out: (t) => (stdout += t),
      err: (t) => (stderr += t),
      options: { timeouts: { barrierMs: 300 }, ...options, probes: { ...greenProbes(), ...options.probes } },
    });
    return { code, stdout, stderr };
  }

  it('exits 0 when browser and trigger are fine, even with warnings', async () => {
    const r = await run(writeConfig(), { probes: { connectHmr: async () => false } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('timeout-only');
    expect(r.stderr).toBe('');
  });

  it('--json --normalize prints the report without timestamps, ports, hashes, timings or absolute paths', async () => {
    const file = writeConfig({ appUrl: 'http://localhost:4567', viteUrl: 'http://localhost:4567', routeParamsFile: '.vp/params.json' });
    let stdout = '';
    const code = await doctorCommand({
      configPath: file,
      env,
      json: true,
      normalize: true,
      out: (t) => (stdout += t),
      err: () => {},
      options: { probes: greenProbes() },
    });
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as DoctorReport;
    expect(report.at).toBe('<timestamp>');
    expect(report.capabilities.barrier.detail).toBe('HMR websocket connected at http://localhost:<port>');
    expect(report.capabilities.browser.detail).toBe('headless Chromium <version> launched and closed');
    expect(report.capabilities.git.detail).toBe('HEAD tree <hash>');
    expect(report.capabilities.params.detail).toBe('routeParamsFile not found: <repo>/.vp/params.json; using 0 entries from config');
    expect(stdout).not.toContain(repo);
    expect(stdout).not.toContain('4567');
    // doctor.json on disk keeps the real values.
    expect(JSON.parse(fs.readFileSync(path.join(dirs.statusDir, 'doctor.json'), 'utf8')).capabilities.barrier.detail).toContain('4567');
  });

  it('exits 1 when the trigger is missing', async () => {
    const r = await run(writeConfig({ screenGlobs: ['nope/**'] }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('a required capability is missing');
  });

  it('exits 1 and still prints the table when the config file is missing', async () => {
    const r = await run(path.join(repo, 'absent.json'));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^config\s+invalid\s+MISSING\s+config file not found/m);
  });
});

describe('real probes against localhost (IPv4 and IPv6 both refused)', () => {
  it('names the error code when the connect error has an empty message', async () => {
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    await new Promise((r) => server.close(r));
    const report = await runDoctor(configure({ appUrl: `http://localhost:${port}`, viteUrl: `http://localhost:${port}` }), {
      dirs,
      probes: { launchBrowser: async () => '1' },
      timeouts: { barrierMs: 500 },
    });
    expect(report.capabilities.login.detail).toMatch(/failed: \S+/);
    expect(report.capabilities.login.detail).toContain('ECONNREFUSED');
  });
});
