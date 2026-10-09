import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { chromium, request as playwrightRequest } from 'playwright';
import { CONFIG_FILE_NAME, ConfigError, loadConfig, routeParamNames, type Config } from './config.js';
import { headTree, isGitRepo } from './git.js';
import { EXIT } from './exit.js';
import { classifier } from './globs.js';
import { ensureDirs, resolveDirs, statusFiles, type Dirs } from './paths.js';
import { buildImportGraph, type ImportGraph } from './resolve/import-graph.js';
import { normalizeDoctorReport } from './normalize.js';
import { fillRoute, type JsonResponse } from './resolve/param-sources.js';
import { loadRouteParams } from './resolve/route-params.js';
import { firstLine, flatten } from './text.js';
import { globBase } from './trigger/fs-watch.js';
import { ViteHmrClient } from './trigger/vite-hmr.js';
// A4 decisions hooks (v0.6): the row's logic lives in src/decisions/doctor.ts.
import { loadApiKey } from './decisions/client.js';
import { describeDecisions, probeWithKey, type DecisionsProbe } from './decisions/doctor.js';

export type CapabilityName = 'config' | 'git' | 'browser' | 'trigger' | 'barrier' | 'freshness' | 'login' | 'routes' | 'params' | 'paramTiers' | 'renderCheck' | 'decisions';
/** `ok`: working at its best tier. `warn`: working at a fallback tier. `missing`: not working. `skipped`: not probed. */
export type CapabilityStatus = 'ok' | 'warn' | 'missing' | 'skipped';

export interface Capability {
  /** The resolved tier, e.g. `vite-hmr` or `timeout-only`. */
  tier: string;
  status: CapabilityStatus;
  /** Nothing can fall back from a required capability; `missing` there fails the run. */
  required: boolean;
  detail: string;
}

export interface DoctorReport {
  at: string;
  /** False only when a required capability (browser, trigger) is missing. */
  ok: boolean;
  capabilities: Record<CapabilityName, Capability>;
}

export interface LoginProbeResult {
  status: number;
}

/** The side-effecting probes; tests substitute fakes. Each rejects with a readable message on failure. */
export interface Probes {
  /** Launch headless Chromium and close it; resolves with the browser version. */
  launchBrowser(timeoutMs: number): Promise<string>;
  /** Fetch the Vite client token and open the HMR websocket; true once connected. */
  connectHmr(config: Config, timeoutMs: number): Promise<boolean>;
  /** Send the login request exactly as `watch` would. */
  login(config: Config, timeoutMs: number): Promise<LoginProbeResult>;
  buildGraph(config: Config): Promise<ImportGraph>;
  /**
   * GET each app-relative path as the logged-in user and decode the JSON (what the watcher does for
   * `paramSources`). One entry per path; a transport failure is `status: 0` with an `error`.
   */
  getJson(config: Config, paths: string[], timeoutMs: number): Promise<JsonResponse[]>;
  /** Whether the app answers HTTP at `appUrl` (any status). Decides whether the decisions models are probed on their own. */
  appUp(config: Config, timeoutMs: number): Promise<boolean>;
  /** One tiny request per decisions model with the key from `env` (or `.env` next to the config). Rejects without a key. */
  probeDecisions(config: Config, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<DecisionsProbe>;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  dirs?: Dirs;
  probes?: Partial<Probes>;
  /** Per-probe timeouts; the slowest one bounds the whole run. */
  timeouts?: { browserMs?: number; barrierMs?: number; loginMs?: number; routesMs?: number; paramsMs?: number; decisionsMs?: number };
  /** `doctor --probe-decisions`: probe the decisions models even when the app is not up. */
  probeDecisions?: boolean;
}

export const CAPABILITY_ORDER: CapabilityName[] = [
  'config',
  'git',
  'browser',
  'trigger',
  'barrier',
  'freshness',
  'login',
  'routes',
  'params',
  'paramTiers',
  'renderCheck',
  'decisions',
];

const BROWSER_MS = 8000;
const BARRIER_MS = 3000;
const LOGIN_MS = 3000;
const ROUTES_MS = 5000;
const PARAMS_MS = 4000;
/** Each decisions model gets one tiny request, all of them together bounded by this (doctor stays under 10 s). */
const DECISIONS_MS = 5000;
const APP_UP_MS = 1500;

export async function runDoctor(config: Config | ConfigError, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const dirs = opts.dirs ?? resolveDirs(opts.env);
  const probes: Probes = { ...defaultProbes, ...opts.probes };
  // Both the routes check and the param tiers need the import graph; build it once.
  const buildGraph = probes.buildGraph;
  const graphs = new Map<Config, Promise<ImportGraph>>();
  probes.buildGraph = (c) => {
    if (!graphs.has(c)) graphs.set(c, buildGraph(c));
    return graphs.get(c)!;
  };
  const t = opts.timeouts ?? {};
  const invalid = config instanceof ConfigError ? config : null;

  const caps = {} as Record<CapabilityName, Capability>;
  caps.config = invalid
    ? { tier: 'invalid', status: 'missing', required: false, detail: flatten(invalid.message) }
    : { tier: 'valid', status: 'ok', required: false, detail: 'config is valid' };

  const skipped = (reason: string): Capability => ({ tier: 'unknown', status: 'skipped', required: false, detail: reason });
  const cfg = invalid ? null : (config as Config);

  const [git, browser, trigger, barrier, login, routes, paramTiers, decisions] = await Promise.all([
    checkGit(cfg),
    checkBrowser(probes, t.browserMs ?? BROWSER_MS),
    cfg ? checkTrigger(cfg, dirs) : { tier: 'none', status: 'missing' as const, required: true, detail: 'config is invalid, so the trigger globs are unknown' },
    cfg ? checkBarrier(cfg, probes, t.barrierMs ?? BARRIER_MS) : skipped('config is invalid'),
    cfg ? checkLogin(cfg, probes, t.loginMs ?? LOGIN_MS) : skipped('config is invalid'),
    cfg ? checkRoutes(cfg, probes, t.routesMs ?? ROUTES_MS) : skipped('config is invalid'),
    cfg ? checkParamTiers(cfg, probes, t.routesMs ?? ROUTES_MS, t.paramsMs ?? PARAMS_MS) : skipped('config is invalid'),
    cfg ? checkDecisions(cfg, probes, opts.env ?? process.env, t.decisionsMs ?? DECISIONS_MS, opts.probeDecisions === true) : skipped('config is invalid'),
  ]);
  caps.git = git;
  caps.browser = browser;
  caps.trigger = trigger;
  caps.barrier = barrier;
  caps.freshness = cfg ? checkFreshness(cfg) : skipped('config is invalid');
  caps.login = login;
  caps.routes = routes;
  caps.params = cfg ? checkParams(cfg) : skipped('config is invalid');
  caps.paramTiers = paramTiers;
  caps.renderCheck = cfg ? checkRenderCheck(cfg) : skipped('config is invalid');
  caps.decisions = decisions;

  const ordered = {} as Record<CapabilityName, Capability>;
  for (const name of CAPABILITY_ORDER) ordered[name] = caps[name];
  const ok = !Object.values(ordered).some((c) => c.required && c.status === 'missing');
  const report: DoctorReport = { at: new Date().toISOString(), ok, capabilities: ordered };

  ensureDirs(dirs);
  const file = statusFiles(dirs).doctor;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return report;
}

// ---- checks -----------------------------------------------------------------

async function checkGit(config: Config | null): Promise<Capability> {
  if (!config) return { tier: 'unknown', status: 'skipped', required: false, detail: 'config is invalid, so the repo is unknown' };
  try {
    if (!(await isGitRepo(config.repoDir))) {
      return { tier: 'none', status: 'missing', required: false, detail: `${config.repoDir} is not a git repository` };
    }
    const tree = await headTree(config.repoDir);
    if (tree === null) return { tier: 'repo', status: 'warn', required: false, detail: 'repository has no commits yet; finish needs one' };
    return { tier: 'repo', status: 'ok', required: false, detail: `HEAD tree ${tree.slice(0, 8)}` };
  } catch (err) {
    return { tier: 'none', status: 'missing', required: false, detail: `git failed: ${firstLine(err)}` };
  }
}

async function checkBrowser(probes: Probes, timeoutMs: number): Promise<Capability> {
  try {
    const version = await withTimeout(probes.launchBrowser(timeoutMs), timeoutMs + 500, 'chromium launch');
    return { tier: 'chromium', status: 'ok', required: true, detail: `headless Chromium ${version} launched and closed` };
  } catch (err) {
    return {
      tier: 'none',
      status: 'missing',
      required: true,
      detail: `${firstLine(err)} (try: npx playwright install chromium)`,
    };
  }
}

async function checkTrigger(config: Config, dirs: Dirs): Promise<Capability> {
  try {
    const { screen, backend, capped } = await countMatches(config, [dirs.statusDir, dirs.scratchDir, dirs.artifactDir]);
    const more = capped ? '+' : '';
    const detail = `${screen}${more} screen file(s), ${backend}${more} backend file(s) match the globs`;
    if (screen === 0) {
      return { tier: 'fs-watch', status: 'missing', required: true, detail: `no files match screenGlobs ${JSON.stringify(config.screenGlobs)}; ${detail}` };
    }
    return { tier: 'fs-watch', status: 'ok', required: true, detail };
  } catch (err) {
    return { tier: 'fs-watch', status: 'missing', required: true, detail: `could not scan the repo: ${firstLine(err)}` };
  }
}

async function checkBarrier(config: Config, probes: Probes, timeoutMs: number): Promise<Capability> {
  try {
    const connected = await withTimeout(probes.connectHmr(config, timeoutMs), timeoutMs + 500, 'HMR connect');
    if (connected) return { tier: 'vite-hmr', status: 'ok', required: false, detail: `HMR websocket connected at ${config.viteUrl}` };
    return {
      tier: 'timeout-only',
      status: 'warn',
      required: false,
      detail: `no HMR websocket within ${timeoutMs} ms at ${config.viteUrl}; captures wait a fixed delay after each save`,
    };
  } catch (err) {
    return { tier: 'timeout-only', status: 'warn', required: false, detail: `HMR unavailable (${firstLine(err)}); captures wait a fixed delay after each save` };
  }
}

function checkFreshness(config: Config): Capability {
  if (!config.freshnessMarker) {
    return { tier: 'none', status: 'ok', required: false, detail: 'no freshnessMarker configured; stale bundles are not detected' };
  }
  const present = fs.existsSync(path.resolve(config.repoDir, config.freshnessMarker));
  return present
    ? { tier: 'marker', status: 'ok', required: false, detail: `marker ${config.freshnessMarker} present` }
    : { tier: 'marker-missing', status: 'warn', required: false, detail: `marker ${config.freshnessMarker} missing; captures are refused until it exists` };
}

async function checkLogin(config: Config, probes: Probes, timeoutMs: number): Promise<Capability> {
  if (config.login.type === 'none') {
    return { tier: 'none', status: 'ok', required: false, detail: 'login not configured; pages are captured unauthenticated' };
  }
  try {
    const { status } = await withTimeout(probes.login(config, timeoutMs), timeoutMs + 500, 'login request');
    if (status >= 200 && status < 300) {
      return { tier: 'http-hook', status: 'ok', required: false, detail: `POST ${config.login.url} -> ${status}` };
    }
    return { tier: 'failed', status: 'warn', required: false, detail: `POST ${config.login.url} -> HTTP ${status}` };
  } catch (err) {
    return { tier: 'failed', status: 'warn', required: false, detail: `POST ${config.login.url} failed: ${firstLine(err)}` };
  }
}

async function checkRoutes(config: Config, probes: Probes, timeoutMs: number): Promise<Capability> {
  const staticFiles = Object.keys(config.staticRoutes).length;
  let failure = '';
  try {
    const graph = await withTimeout(probes.buildGraph(config), timeoutMs, 'route graph');
    if (graph.routes.length > 0) {
      return {
        tier: 'import-graph',
        status: 'ok',
        required: false,
        detail: `${graph.routes.length} route(s), ${graph.fileToRoutes.size} file(s) mapped, ${graph.unresolved.length} unresolved`,
      };
    }
    failure = `no routes found in ${JSON.stringify(config.routeFiles)}`;
  } catch (err) {
    failure = `import graph failed: ${firstLine(err)}`;
  }
  if (staticFiles > 0) {
    return { tier: 'static-map', status: 'warn', required: false, detail: `${staticFiles} file(s) mapped in staticRoutes (${failure})` };
  }
  return { tier: 'none', status: 'warn', required: false, detail: `${failure}; no staticRoutes either, so no file maps to a route` };
}

/** Where route params come from: the seed file, else the config, else nowhere. Informational, never required. */
function checkParams(config: Config): Capability {
  const seed = loadRouteParams(config);
  const configCount = Object.keys(config.routeParams).length;
  const fallback = (): Capability =>
    configCount > 0
      ? { tier: 'config', status: 'ok', required: false, detail: `${configCount} ${entries(configCount)}` }
      : { tier: 'none', status: 'ok', required: false, detail: 'no routeParams; param routes cannot be captured' };

  if (!seed.file) return fallback();
  if (seed.missing) {
    const base = fallback();
    return { ...base, status: 'warn', detail: `routeParamsFile not found: ${seed.file}; using ${configCount} ${entries(configCount)} from config` };
  }
  if (seed.error) {
    return { tier: 'invalid', status: 'missing', required: false, detail: `${seed.error}; using ${configCount} ${entries(configCount)} from config` };
  }
  const detail = `${seed.fileEntries} ${entries(seed.fileEntries)} from ${config.routeParamsFile}`;
  if (seed.warnings.length > 0) {
    const more = seed.warnings.length > 1 ? ` (+${seed.warnings.length - 1} more)` : '';
    return { tier: 'seed-file', status: 'warn', required: false, detail: `${detail}; ${seed.warnings[0]}${more}` };
  }
  return { tier: 'seed-file', status: 'ok', required: false, detail };
}

/**
 * How many routes with params each tier covers: `routeParams`, the seed file, or a `paramSources` list endpoint
 * (earlier tiers win). Each configured source is probed once, as the logged-in user, when the app answers.
 * Informational, never required.
 */
async function checkParamTiers(config: Config, probes: Probes, graphMs: number, probeMs: number): Promise<Capability> {
  const seed = loadRouteParams(config);
  const sourceKeys = Object.keys(config.paramSources);

  const routeKeys = new Set<string>();
  try {
    const graph = await withTimeout(probes.buildGraph(config), graphMs, 'route graph');
    for (const route of graph.routes) routeKeys.add(route.path);
  } catch {
    // Without a graph, only the keys the tiers name can be counted.
    for (const key of [...Object.keys(config.routeParams), ...seed.fileKeys, ...sourceKeys]) routeKeys.add(key);
  }
  for (const key of Object.values(config.staticRoutes).flat()) routeKeys.add(key);
  const paramRoutes = [...routeKeys].filter((key) => routeParamNames(key).length > 0).sort();

  const fileKeys = new Set(seed.fileKeys);
  const counts = { config: 0, 'seed-file': 0, 'list-endpoint': 0, uncovered: 0 };
  const uncovered: string[] = [];
  for (const key of paramRoutes) {
    if (fileKeys.has(key)) counts['seed-file']++;
    else if (Object.hasOwn(config.routeParams, key)) counts.config++;
    else if (Object.hasOwn(config.paramSources, key)) counts['list-endpoint']++;
    else {
      counts.uncovered++;
      uncovered.push(key);
    }
  }
  const parts = [
    `${paramRoutes.length} route(s) with params: config ${counts.config}, seed-file ${counts['seed-file']}, list-endpoint ${counts['list-endpoint']}, uncovered ${counts.uncovered}`,
  ];
  let warn = counts.uncovered > 0;
  if (uncovered.length > 0) parts.push(`uncovered: ${uncovered.join(', ')}`);
  const stray = sourceKeys.filter((key) => !paramRoutes.includes(key));
  if (stray.length > 0 && paramRoutes.length > 0) {
    warn = true;
    parts.push(`paramSources for no known route: ${stray.join(', ')}`);
  }

  if (sourceKeys.length > 0) {
    const sources = sourceKeys.map((key) => config.paramSources[key]!);
    let responses: JsonResponse[] | null = null;
    try {
      responses = await withTimeout(probes.getJson(config, sources.map((s) => s.url), probeMs), probeMs + 500, 'paramSources probe');
    } catch (err) {
      parts.push(`paramSources not probed: ${firstLine(err)}`);
      warn = true;
    }
    if (responses && responses.length > 0 && responses.every((r) => r.status === 0)) {
      parts.push(`paramSources not probed: app not reachable at ${config.appUrl} (${responses[0]!.error ?? 'no answer'})`);
      warn = true;
    } else if (responses) {
      sourceKeys.forEach((key, i) => {
        const source = sources[i]!;
        const response = responses![i];
        if (!response || response.error !== undefined) {
          warn = true;
          parts.push(`probe ${source.url} for ${key} failed: ${response?.error ?? 'no answer'}`);
          return;
        }
        const filled = fillRoute(key, source, response.json);
        if (filled.ok) parts.push(`probe ${source.url} -> ${filled.path}`);
        else {
          warn = true;
          parts.push(`probe ${source.url} for ${key}: ${filled.reason}`);
        }
      });
    }
  }

  return {
    tier: sourceKeys.length > 0 ? 'list-endpoint' : 'none',
    status: warn ? 'warn' : 'ok',
    required: false,
    detail: parts.join('; '),
  };
}

/** The mode of the rendered-component check in `finish`. Informational, never required. */
function checkRenderCheck(config: Config): Capability {
  if (config.renderCheck === 'fail') {
    return { tier: 'fail', status: 'ok', required: false, detail: 'finish fails when a changed .vue file never rendered on its routes' };
  }
  if (config.renderCheck === 'warn') {
    return { tier: 'warn', status: 'warn', required: false, detail: 'finish only notes a changed .vue file that never rendered (renderCheck: "warn")' };
  }
  return { tier: 'off', status: 'warn', required: false, detail: 'rendered components are not checked (renderCheck: "off")' };
}

/**
 * A4: is there a key, do the models resolve, what mode is on. The probe (one tiny request per model, bounded)
 * only runs with `--probe-decisions` or when the app is up, so a doctor run without either stays offline.
 * Informational, never required.
 */
async function checkDecisions(config: Config, probes: Probes, env: NodeJS.ProcessEnv, timeoutMs: number, force: boolean): Promise<Capability> {
  const key = loadApiKey(env, config.repoDir);
  const d = config.decisions;
  let probe: DecisionsProbe | null = null;
  const why = 'run doctor --probe-decisions, or start the app';
  if (key && d.enabled !== false) {
    const up = force || (await probes.appUp(config, APP_UP_MS).catch(() => false));
    if (up) {
      try {
        probe = await withTimeout(probes.probeDecisions(config, env, timeoutMs), timeoutMs + 500, 'decisions probe');
      } catch (err) {
        return { tier: 'degraded', status: 'warn', required: false, detail: `key found; the decisions probe failed: ${firstLine(err)}` };
      }
    }
  }
  const result = describeDecisions(d, key, probe, why);
  return { tier: result.tier, status: result.status, required: false, detail: result.detail };
}

function entries(n: number): string {
  return n === 1 ? 'entry' : 'entries';
}

// ---- probes -----------------------------------------------------------------

const defaultProbes: Probes = {
  async launchBrowser(timeoutMs) {
    const browser = await chromium.launch({ headless: true, timeout: timeoutMs, args: ['--disable-dev-shm-usage'] });
    try {
      return browser.version();
    } finally {
      await browser.close().catch(() => {});
    }
  },

  async connectHmr(config, timeoutMs) {
    const client = new ViteHmrClient({
      viteUrl: config.viteUrl,
      ignoreHTTPSErrors: config.ignoreHTTPSErrors,
      connectTimeoutMs: timeoutMs - 500,
    });
    client.start();
    try {
      return await client.waitForConnected(timeoutMs);
    } finally {
      await client.stop();
    }
  },

  async login(config, timeoutMs) {
    const { login, appUrl, repoDir } = config;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (login.tokenFile) {
      try {
        headers[login.tokenHeader] = fs.readFileSync(path.resolve(repoDir, login.tokenFile), 'utf8').trim();
      } catch (err) {
        throw new Error(`cannot read token file ${login.tokenFile} (${(err as NodeJS.ErrnoException).code ?? firstLine(err)})`);
      }
    }
    const target = new URL(login.url ?? '/', appUrl.endsWith('/') ? appUrl : `${appUrl}/`);
    return { status: await post(target, headers, JSON.stringify({ email: login.email }), config.ignoreHTTPSErrors, timeoutMs) };
  },

  buildGraph: (config) => buildImportGraph(config),

  async appUp(config, timeoutMs) {
    try {
      const res = await fetch(config.appUrl, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      await res.body?.cancel().catch(() => {});
      return true;
    } catch {
      return false;
    }
  },

  probeDecisions: (config, env, timeoutMs) => probeWithKey(env, config.repoDir, config.decisions.models, timeoutMs),

  async getJson(config, paths, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(250, deadline - Date.now());
    const base = config.appUrl.endsWith('/') ? config.appUrl : `${config.appUrl}/`;
    const api = await playwrightRequest.newContext({ ignoreHTTPSErrors: config.ignoreHTTPSErrors });
    try {
      const { login } = config;
      if (login.type === 'http-hook' && login.url) {
        const headers: Record<string, string> = {};
        if (login.tokenFile) {
          try {
            headers[login.tokenHeader] = fs.readFileSync(path.resolve(config.repoDir, login.tokenFile), 'utf8').trim();
          } catch {
            // The login check reports the unreadable token; the probes below then show what an anonymous GET gets.
          }
        }
        await api
          .post(new URL(login.url, base).href, { data: { email: login.email }, headers, failOnStatusCode: false, maxRedirects: 0, timeout: left() })
          .catch(() => {});
      }
      return await Promise.all(
        paths.map(async (urlPath): Promise<JsonResponse> => {
          try {
            const response = await api.get(new URL(urlPath, base).href, { failOnStatusCode: false, timeout: left(), headers: { accept: 'application/json' } });
            const status = response.status();
            if (status < 200 || status >= 300) return { status, error: `HTTP ${status}` };
            try {
              return { status, json: await response.json() };
            } catch {
              return { status, error: 'response is not JSON' };
            }
          } catch (err) {
            return { status: 0, error: firstLine(err) };
          }
        }),
      );
    } finally {
      await api.dispose().catch(() => {});
    }
  },
};

function post(url: URL, headers: Record<string, string>, body: string, ignoreHTTPSErrors: boolean, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, rejectUnauthorized: !ignoreHTTPSErrors, timeout: timeoutMs },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

// ---- helpers ----------------------------------------------------------------

const SCAN_CAP = 100_000;
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Files under the glob bases that match `screenGlobs` / `backendGlobs`. */
async function countMatches(config: Config, ignored: string[]): Promise<{ screen: number; backend: number; capped: boolean }> {
  const { isScreen, isBackend } = classifier(config);
  const ignoredRoots = ignored.map((p) => path.resolve(p));
  const bases = [...new Set([...config.screenGlobs, ...config.backendGlobs].map(globBase))];
  // A base inside another base is covered by the outer walk.
  const roots = bases.filter((b) => !bases.some((o) => o !== b && (o === '' || b.startsWith(`${o}/`))));

  let screen = 0;
  let backend = 0;
  let visited = 0;
  const seen = new Set<string>();
  const walk = async (dirRel: string): Promise<void> => {
    const abs = path.join(config.repoDir, dirRel);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      return; // a glob base that does not exist matches nothing
    }
    for (const entry of entries) {
      if (visited >= SCAN_CAP) return;
      const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) {
        const full = path.join(config.repoDir, rel);
        if (SKIP_DIRS.has(entry.name) || ignoredRoots.some((r) => full === r || full.startsWith(r + path.sep))) continue;
        await walk(rel);
      } else if (entry.isFile() && !seen.has(rel)) {
        seen.add(rel);
        visited++;
        if (isScreen(rel)) screen++;
        if (isBackend(rel)) backend++;
      }
    }
  };
  for (const root of roots) await walk(root);
  return { screen, backend, capped: visited >= SCAN_CAP };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  promise.catch(() => {}); // a late rejection after the timeout must not be unhandled
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---- CLI --------------------------------------------------------------------

/** Fixed-width table of the report, one row per capability. */
export function formatReport(report: DoctorReport): string {
  const rows = CAPABILITY_ORDER.map((name) => {
    const c = report.capabilities[name];
    return [name, c.tier, c.status === 'missing' ? 'MISSING' : c.status, c.detail];
  });
  const header = ['capability', 'tier', 'status', 'detail'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cols: string[]): string =>
    cols.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i]!))).join('  ');
  return `${[line(header), ...rows.map(line)].join('\n')}\n`;
}

export interface DoctorCommandContext {
  configPath?: string;
  /** Print the report as JSON instead of the table. */
  json?: boolean;
  /** With `json`: strip ports, absolute paths, hashes, timings and versions, so the output can be checked in as a golden. */
  normalize?: boolean;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
  options?: DoctorOptions;
}

/**
 * `visual-proof doctor [--json]`: 0, or 1 when the browser or the trigger is missing (an invalid
 * config also leaves the trigger unknown, hence missing), or 4 when doctor itself breaks.
 */
export async function doctorCommand(ctx: DoctorCommandContext): Promise<number> {
  const out = ctx.out ?? ((t) => process.stdout.write(t));
  const err = ctx.err ?? ((t) => process.stderr.write(t));
  const cwd = ctx.cwd ?? process.cwd();
  let config: Config | ConfigError;
  try {
    config = loadConfig({ configPath: path.resolve(cwd, ctx.configPath ?? CONFIG_FILE_NAME), cwd, env: ctx.env });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    config = e;
  }
  try {
    const report = await runDoctor(config, { env: ctx.env, ...ctx.options });
    if (ctx.json) {
      const dirs = ctx.options?.dirs ?? resolveDirs(ctx.env);
      const shown = ctx.normalize
        ? normalizeDoctorReport(report, {
            roots: [
              ...(config instanceof ConfigError ? [] : [{ path: config.repoDir, label: '<repo>' }]),
              { path: dirs.statusDir, label: '<status-dir>' },
              { path: dirs.scratchDir, label: '<scratch-dir>' },
              { path: dirs.artifactDir, label: '<artifact-dir>' },
              { path: cwd, label: '<cwd>' },
            ],
          })
        : report;
      out(`${JSON.stringify(shown, null, 2)}\n`);
    }
    else out(`${formatReport(report)}details: ${statusFiles(ctx.options?.dirs ?? resolveDirs(ctx.env)).doctor}\n`);
    if (!report.ok) err('visual-proof doctor: a required capability is missing (browser or trigger)\n');
    return report.ok ? EXIT.OK : EXIT.FAILURES;
  } catch (e) {
    err(`visual-proof doctor: ${firstLine(e)}\n`);
    return EXIT.INTERNAL;
  }
}
