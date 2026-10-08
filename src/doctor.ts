import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { chromium } from 'playwright';
import { CONFIG_FILE_NAME, ConfigError, loadConfig, type Config } from './config.js';
import { headTree, isGitRepo } from './git.js';
import { classifier } from './globs.js';
import { ensureDirs, resolveDirs, statusFiles, type Dirs } from './paths.js';
import { buildImportGraph, type ImportGraph } from './resolve/import-graph.js';
import { globBase } from './trigger/fs-watch.js';
import { ViteHmrClient } from './trigger/vite-hmr.js';

export type CapabilityName = 'config' | 'git' | 'browser' | 'trigger' | 'barrier' | 'freshness' | 'login' | 'routes';
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
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  dirs?: Dirs;
  probes?: Partial<Probes>;
  /** Per-probe timeouts; the slowest one bounds the whole run. */
  timeouts?: { browserMs?: number; barrierMs?: number; loginMs?: number; routesMs?: number };
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
];

const BROWSER_MS = 8000;
const BARRIER_MS = 3000;
const LOGIN_MS = 3000;
const ROUTES_MS = 5000;

export async function runDoctor(config: Config | ConfigError, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const dirs = opts.dirs ?? resolveDirs(opts.env);
  const probes: Probes = { ...defaultProbes, ...opts.probes };
  const t = opts.timeouts ?? {};
  const invalid = config instanceof ConfigError ? config : null;

  const caps = {} as Record<CapabilityName, Capability>;
  caps.config = invalid
    ? { tier: 'invalid', status: 'missing', required: false, detail: flatten(invalid.message) }
    : { tier: 'valid', status: 'ok', required: false, detail: 'config is valid' };

  const skipped = (reason: string): Capability => ({ tier: 'unknown', status: 'skipped', required: false, detail: reason });
  const cfg = invalid ? null : (config as Config);

  const [git, browser, trigger, barrier, login, routes] = await Promise.all([
    checkGit(cfg),
    checkBrowser(probes, t.browserMs ?? BROWSER_MS),
    cfg ? checkTrigger(cfg, dirs) : { tier: 'none', status: 'missing' as const, required: true, detail: 'config is invalid, so the trigger globs are unknown' },
    cfg ? checkBarrier(cfg, probes, t.barrierMs ?? BARRIER_MS) : skipped('config is invalid'),
    cfg ? checkLogin(cfg, probes, t.loginMs ?? LOGIN_MS) : skipped('config is invalid'),
    cfg ? checkRoutes(cfg, probes, t.routesMs ?? ROUTES_MS) : skipped('config is invalid'),
  ]);
  caps.git = git;
  caps.browser = browser;
  caps.trigger = trigger;
  caps.barrier = barrier;
  caps.freshness = cfg ? checkFreshness(cfg) : skipped('config is invalid');
  caps.login = login;
  caps.routes = routes;

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

function flatten(message: string): string {
  return message
    .split('\n')
    .map((l) => l.trim().replace(/^- /, ''))
    .filter(Boolean)
    .join('; ');
}

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

/**
 * One readable line for a failure. Node's connect errors for `localhost` (tried over IPv4 and IPv6)
 * are AggregateErrors with an empty message, so fall back to the error code.
 */
function firstLine(err: unknown): string {
  if (err instanceof Error) {
    const line = err.message.split('\n')[0];
    if (line) return line;
    const code = (err as NodeJS.ErrnoException).code;
    if (code) return code;
    if (err instanceof AggregateError && err.errors.length > 0) return firstLine(err.errors[0]);
    return err.name;
  }
  return String(err).split('\n')[0] || 'unknown error';
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
  env: NodeJS.ProcessEnv;
  cwd?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
  options?: DoctorOptions;
}

/** `visual-proof doctor`; exits non-zero only when the browser or the trigger is missing. */
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
    out(formatReport(report));
    if (!report.ok) err('visual-proof doctor: a required capability is missing (browser or trigger)\n');
    return report.ok ? 0 : 1;
  } catch (e) {
    err(`visual-proof doctor: ${firstLine(e)}\n`);
    return 1;
  }
}
