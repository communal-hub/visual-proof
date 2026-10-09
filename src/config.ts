import fs from 'node:fs';
import path from 'node:path';
import { parseDecisions, type DecisionsConfig } from './decisions/config.js';

export const CONFIG_FILE_NAME = 'visual-proof.config.json';

/**
 * Dev overlays that float over the app in a Vite dev server and have no business in a still.
 * Sources (read from the published packages):
 *  - `#__vue-devtools-container__`: root element vite-plugin-vue-devtools 8.x appends to `<body>`; it holds the
 *    floating pill (`.vue-devtools__anchor`), the panel iframe (`.vue-devtools-frame`) and its resize handles.
 *  - `.vue-devtools__anchor`, `.vue-devtools-frame`: the pill and panel by class, in case the root id changes.
 *  - `#vue-devtools-anchor`: the pill's id in older vite-plugin-vue-devtools releases (still referenced by 7.x CSS).
 *  - `#__vue-devtools-component-inspector__`: @vue/devtools-kit's component-inspector highlight box.
 *  - `.vue-inspector-container`: vite-plugin-vue-inspector's floating toggle (standalone use or through devtools).
 * `vite-error-overlay` is deliberately absent: an error on screen is evidence. `[data-v-inspector]` is absent too:
 * vite-plugin-vue-inspector stamps that attribute on every element of the app, so hiding it would hide the app.
 */
export const DEFAULT_HIDE_SELECTORS: readonly string[] = [
  '#__vue-devtools-container__',
  '.vue-devtools__anchor',
  '.vue-devtools-frame',
  '#vue-devtools-anchor',
  '#__vue-devtools-component-inspector__',
  '.vue-inspector-container',
];

/**
 * Analytics and tracker hosts that are aborted by default: they add network noise, console errors and flaky
 * late requests, and none of them shape the layout. Deliberately absent: payment widgets (Stripe), maps, fonts and
 * CDNs, which do. A config `blockHosts` replaces this list; `allowHosts` carves exceptions out of it.
 * `*.example.com` matches `example.com` and every subdomain of it.
 */
export const DEFAULT_BLOCK_HOSTS: readonly string[] = [
  '*.google-analytics.com',
  '*.googletagmanager.com',
  '*.posthog.com',
  '*.segment.io',
  '*.hotjar.com',
  '*.intercom.io',
  '*.sentry.io',
];

export type RenderCheckMode = 'fail' | 'warn' | 'off';

/** How a route with params that no earlier tier fills gets an id (v0.8): from the links of its parent page, or not at all. */
export type ParamDiscoveryMode = 'links' | 'off';

export const DEFAULT_MAX_CAPTURE_HEIGHT = 6000;
export const DEFAULT_WARMUP_BUDGET_MS = 60_000;
export const DEFAULT_NETWORK_IDLE_MS = 250;
export const DEFAULT_SETTLE_MAX_WAIT_MS = 5000;
export const DEFAULT_SIDECARS: readonly string[] = ['.visual-proof/sidecars/*.vp'];
export const DEFAULT_REPLAY_MAX_FRAMES = 60;
export const DEFAULT_REPLAY_SECONDS_PER_FRAME = 1.2;
export const DEFAULT_REPLAY_MAX_HEIGHT = 1600;
/** Role names usable in `login <role>`; `default` is reserved for the configured login email. */
export const ROLE_NAME = /^[A-Za-z0-9._-]+$/;
export const DEFAULT_ROLE = 'default';

/** The replay video `finish` builds from the session's frames when ffmpeg is on PATH. */
export interface ReplayConfig {
  enabled: boolean;
  /** At most this many frames (the latest) go into the video. */
  maxFrames: number;
  /** How long each frame is shown. */
  secondsPerFrame: number;
  /** Cap on the canvas height (CSS px); the width is the viewport width. */
  maxHeight: number;
}

/** How a route key gets its params from a list endpoint (see `paramSources`). */
export interface ParamSourceConfig {
  /** App-relative API path (starts with `/`), fetched with the watcher's logged-in browser context. */
  url: string;
  /**
   * Where in the JSON response the value comes from: a dot/index path (`data.0.id`, `0.uuid`) or a quoted literal
   * (`'invoices'`). A string for a route with one param; an object of param name to pick for any number of params.
   */
  pick: string | Record<string, string>;
}

export interface LoginConfig {
  type: 'http-hook' | 'none';
  url?: string;
  email?: string;
  tokenHeader: string;
  tokenFile?: string;
}

export interface Config {
  /** Directory containing the config file; all repo-relative paths resolve against it. */
  repoDir: string;
  appUrl: string;
  viteUrl: string;
  freshnessMarker?: string;
  ignoreHTTPSErrors: boolean;
  viewport: { width: number; height: number };
  routeFiles: string[];
  srcRoots: string[];
  aliases: Record<string, string>;
  staticRoutes: Record<string, string[]>;
  routeParams: Record<string, string>;
  /** JSON file of route params written at runtime by the app (e.g. a seeder); relative to `repoDir`. Overrides `routeParams`. */
  routeParamsFile?: string;
  /**
   * Third tier of route params, used when neither `routeParams` nor the seed file has the route: fetch `url` and
   * `pick` the param(s) out of the JSON. Resolved lazily, cached per session, refreshed on a backend recapture.
   */
  paramSources: Record<string, ParamSourceConfig>;
  /** Globs (relative to `repoDir`) of sidecar scenario files (`.vp`): scripted interaction steps that end in stills. */
  sidecars: string[];
  /** Role name to login email, for `login <role>` in a sidecar. `login default` is the configured `login.email`. */
  roles: Record<string, string>;
  /** The replay video built at `finish`. */
  replay: ReplayConfig;
  /**
   * v0.8, the last tier of route params: `links` (default) loads the nearest parent route and takes the first link
   * that fits the route's pattern; `off` leaves the route unfilled. Session params set with `visual-proof params set`
   * outrank every tier.
   */
  paramDiscovery: ParamDiscoveryMode;
  screenGlobs: string[];
  /** Files matching these are never screens, even when they match `screenGlobs` (shared helpers, stories, tests). */
  ignoreScreenGlobs: string[];
  backendGlobs: string[];
  login: LoginConfig;
  appRoot: string;
  spinnerSelectors: string[];
  /**
   * Routes (route keys or concrete paths) visited before the watcher reports `ready`, so Vite compiles and
   * optimizes dependencies ahead of the first real capture. Undefined: the first route of the import graph
   * without unfilled params, else `/`. An empty array disables the warm-up.
   */
  warmupRoutes?: string[];
  /** Total time the warm-up may take before it is abandoned (the watcher still becomes ready). */
  warmupBudgetMs: number;
  /** CSS selector of the element that scrolls inside the page; undefined detects the largest scroller. */
  scrollContainer?: string;
  /** Stills taller than this many CSS pixels are cut off at this height. */
  maxCaptureHeight: number;
  /** Selectors hidden (`visibility: hidden`) before a screenshot: {@link DEFAULT_HIDE_SELECTORS} plus the configured ones. */
  hideSelectors: string[];
  /**
   * Whether `finish` requires every changed `.vue` file to have rendered on at least one of its routes:
   * `fail` (default) makes "never rendered" a failure, `warn` a note, `off` skips the check (and the capture-time walk).
   */
  renderCheck: RenderCheckMode;
  /** ISO timestamp the page clock is frozen at (`Date.now()`, `new Date()`); undefined leaves time alone. */
  fixedTime?: string;
  /** Playwright selectors covered by a solid box in stills (the area still takes part in the layout). */
  maskSelectors: string[];
  /** Hostname globs whose requests are aborted before navigation. Default {@link DEFAULT_BLOCK_HOSTS}. */
  blockHosts: string[];
  /** Hostname globs exempt from `blockHosts`. The app's own hosts are never blocked. */
  allowHosts: string[];
  /** When a page counts as settled: no network for `networkIdleMs`, waiting at most `maxWaitMs`. */
  settle: { networkIdleMs: number; maxWaitMs: number };
  maxFrames: number;
  finishBudgetMs: number;
  baseRef: string;
  // A4 decisions (src/decisions/**): model calls at bounded decision points, never navigation.
  decisions: DecisionsConfig;
  /** File holding the claim the change is meant to prove (bullet lines are criteria); relative to `repoDir`. Default `<statusDir>/claim.md`. */
  claimFile?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface LoadConfigOptions {
  /** Explicit config path (relative paths resolve against cwd). Defaults to `<cwd>/visual-proof.config.json`. */
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const cwd = options.cwd ?? process.cwd();
  const file = path.resolve(cwd, options.configPath ?? CONFIG_FILE_NAME);

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(`config file not found: ${file}`);
    }
    throw err;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${file}: invalid JSON (${(err as Error).message})`);
  }

  return parseConfig(raw, path.dirname(file), options.env ?? process.env, file);
}

/** Validate a decoded config object and apply defaults and env overrides. */
export function parseConfig(
  raw: unknown,
  repoDir: string,
  env: NodeJS.ProcessEnv = process.env,
  source = CONFIG_FILE_NAME,
): Config {
  if (!isRecord(raw)) throw new ConfigError(`${source}: top level must be a JSON object`);

  const errors: string[] = [];
  const v = new Validator(raw, errors);

  const fileAppUrl = v.url('appUrl');
  if (raw.appUrl === undefined && !env.VISUAL_PROOF_APP_URL) errors.push('"appUrl" is required');
  const appUrl = env.VISUAL_PROOF_APP_URL || fileAppUrl;
  const viteUrl = env.VISUAL_PROOF_VITE_URL || v.url('viteUrl');
  for (const name of ['VISUAL_PROOF_APP_URL', 'VISUAL_PROOF_VITE_URL']) {
    const value = env[name];
    if (value && !isHttpUrl(value)) errors.push(`${name} must be an http(s) URL, got ${JSON.stringify(value)}`);
  }

  const viewportRaw = v.object('viewport');
  const vp = viewportRaw ? new Validator(viewportRaw, errors, 'viewport.') : undefined;

  const settleRaw = v.object('settle');
  const settle = settleRaw ? new Validator(settleRaw, errors, 'settle.') : undefined;

  const replayRaw = v.object('replay');
  const replayV = replayRaw ? new Validator(replayRaw, errors, 'replay.') : undefined;

  const loginRaw = v.object('login');
  const login = loginRaw ? parseLogin(loginRaw, errors) : defaultLogin();

  const config: Config = {
    repoDir,
    appUrl: appUrl ?? '',
    viteUrl: viteUrl ?? appUrl ?? '',
    freshnessMarker: v.string('freshnessMarker'),
    ignoreHTTPSErrors: v.boolean('ignoreHTTPSErrors') ?? false,
    viewport: { width: vp?.posInt('width') ?? 1280, height: vp?.posInt('height') ?? 800 },
    routeFiles: v.stringArray('routeFiles') ?? ['src/router/**/*.{js,ts}'],
    srcRoots: v.stringArray('srcRoots') ?? ['src'],
    aliases: v.stringMap('aliases') ?? { '@': 'src' },
    staticRoutes: v.stringArrayMap('staticRoutes') ?? {},
    routeParams: v.stringMap('routeParams') ?? {},
    routeParamsFile: v.string('routeParamsFile'),
    paramSources: parseParamSources(v.object('paramSources'), errors),
    sidecars: v.stringArray('sidecars') ?? [...DEFAULT_SIDECARS],
    roles: parseRoles(v.stringMap('roles'), errors),
    replay: {
      enabled: replayV?.boolean('enabled') ?? true,
      maxFrames: replayV?.posInt('maxFrames') ?? DEFAULT_REPLAY_MAX_FRAMES,
      secondsPerFrame: replayV?.posNumber('secondsPerFrame') ?? DEFAULT_REPLAY_SECONDS_PER_FRAME,
      maxHeight: replayV?.posInt('maxHeight') ?? DEFAULT_REPLAY_MAX_HEIGHT,
    },
    paramDiscovery: parseParamDiscovery(v.string('paramDiscovery'), errors),
    screenGlobs: v.stringArray('screenGlobs') ?? ['src/**/*.vue'],
    ignoreScreenGlobs: v.stringArray('ignoreScreenGlobs') ?? [],
    backendGlobs: v.stringArray('backendGlobs') ?? [],
    login,
    appRoot: v.string('appRoot') ?? '#app',
    spinnerSelectors: v.stringArray('spinnerSelectors') ?? ['.spinner', '[aria-busy=true]'],
    warmupRoutes: v.stringArray('warmupRoutes'),
    warmupBudgetMs: v.posInt('warmupBudgetMs') ?? DEFAULT_WARMUP_BUDGET_MS,
    scrollContainer: v.string('scrollContainer'),
    maxCaptureHeight: v.posInt('maxCaptureHeight') ?? DEFAULT_MAX_CAPTURE_HEIGHT,
    hideSelectors: hideSelectors(v.stringArray('hideSelectors'), v.boolean('hideSelectorsReplace') ?? false),
    renderCheck: parseRenderCheck(v.string('renderCheck'), errors),
    fixedTime: parseFixedTime(v.string('fixedTime'), errors),
    maskSelectors: v.stringArray('maskSelectors') ?? [],
    blockHosts: hostGlobs('blockHosts', v.stringArray('blockHosts'), errors) ?? [...DEFAULT_BLOCK_HOSTS],
    allowHosts: hostGlobs('allowHosts', v.stringArray('allowHosts'), errors) ?? [],
    settle: {
      networkIdleMs: settle?.posInt('networkIdleMs') ?? DEFAULT_NETWORK_IDLE_MS,
      maxWaitMs: settle?.posInt('maxWaitMs') ?? DEFAULT_SETTLE_MAX_WAIT_MS,
    },
    maxFrames: v.posInt('maxFrames') ?? 200,
    finishBudgetMs: v.posInt('finishBudgetMs') ?? 25_000,
    baseRef: v.string('baseRef') ?? 'main',
    decisions: parseDecisions(raw.decisions, errors),
    claimFile: v.string('claimFile'),
  };

  if (errors.length > 0) {
    throw new ConfigError(`${source}: invalid config\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return config;
}

/** Defaults plus the configured selectors (deduplicated), or only the configured ones when `replace` is set. */
function hideSelectors(configured: string[] | undefined, replace: boolean): string[] {
  const extra = configured ?? [];
  return [...new Set(replace ? extra : [...DEFAULT_HIDE_SELECTORS, ...extra])];
}

function parseFixedTime(value: string | undefined, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value))) {
    errors.push(`"fixedTime" must be an ISO 8601 timestamp such as "2026-01-15T09:00:00Z", got ${JSON.stringify(value)}`);
    return undefined;
  }
  return value;
}

/** Hostname globs: no scheme, port or path (`*.example.com`, `cdn.example.com`, `*`). */
function hostGlobs(key: string, value: string[] | undefined, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  for (const glob of value) {
    if (glob === '' || /[/:\s]/.test(glob)) {
      errors.push(`"${key}" entries must be hostname globs without scheme, port or path (like "*.example.com"), got ${JSON.stringify(glob)}`);
    }
  }
  return value;
}

const ROUTE_PARAM = /:([A-Za-z_]\w*)/g;

/** Param names of a route key (`/a/:id/:tab` -> `['id', 'tab']`). */
export function routeParamNames(routeKey: string): string[] {
  return [...routeKey.matchAll(ROUTE_PARAM)].map((m) => m[1]!);
}

function parseParamSources(raw: Record<string, unknown> | undefined, errors: string[]): Record<string, ParamSourceConfig> {
  const sources: Record<string, ParamSourceConfig> = {};
  for (const [key, entry] of Object.entries(raw ?? {})) {
    const where = `paramSources[${JSON.stringify(key)}]`;
    const names = routeParamNames(key);
    if (names.length === 0) {
      errors.push(`"${where}" is not a route with params (nothing to fill in ${JSON.stringify(key)})`);
      continue;
    }
    if (!isRecord(entry)) {
      errors.push(`"${where}" must be an object { url, pick }, got ${JSON.stringify(entry)}`);
      continue;
    }
    const { url, pick } = entry;
    let ok = true;
    if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) {
      errors.push(`"${where}.url" must be an app-relative path starting with "/", got ${JSON.stringify(url)}`);
      ok = false;
    }
    if (typeof pick === 'string') {
      if (pick === '') {
        errors.push(`"${where}.pick" must not be empty`);
        ok = false;
      } else if (names.length > 1) {
        errors.push(`"${where}.pick" must be an object of param to pick for ${names.join(', ')}, got a string`);
        ok = false;
      }
    } else if (isRecord(pick)) {
      const given = Object.keys(pick);
      const bad = given.filter((k) => typeof pick[k] !== 'string' || pick[k] === '');
      const missing = names.filter((n) => !given.includes(n));
      const extra = given.filter((k) => !names.includes(k));
      if (bad.length > 0 || missing.length > 0 || extra.length > 0) {
        const problems = [
          ...bad.map((k) => `${k} is not a non-empty string`),
          ...missing.map((n) => `missing ${n}`),
          ...extra.map((k) => `${k} is not a param of the route`),
        ];
        errors.push(`"${where}.pick" must map each of ${names.join(', ')} to a path: ${problems.join('; ')}`);
        ok = false;
      }
    } else {
      errors.push(`"${where}.pick" must be a string or an object of param to path, got ${JSON.stringify(pick)}`);
      ok = false;
    }
    if (ok) sources[key] = { url: url as string, pick: pick as string | Record<string, string> };
  }
  return sources;
}

function parseRoles(raw: Record<string, string> | undefined, errors: string[]): Record<string, string> {
  const roles: Record<string, string> = {};
  for (const [role, email] of Object.entries(raw ?? {})) {
    if (!ROLE_NAME.test(role)) {
      errors.push(`"roles" key ${JSON.stringify(role)} must be letters, digits, ".", "_" or "-"`);
    } else if (role === DEFAULT_ROLE) {
      errors.push(`"roles" key "${DEFAULT_ROLE}" is reserved: it always means the configured login.email`);
    } else if (email === '') {
      errors.push(`"roles.${role}" must be a non-empty login email`);
    } else {
      roles[role] = email;
    }
  }
  return roles;
}

function parseRenderCheck(value: string | undefined, errors: string[]): RenderCheckMode {
  if (value === undefined) return 'fail';
  if (value === 'fail' || value === 'warn' || value === 'off') return value;
  errors.push(`"renderCheck" must be "fail", "warn" or "off", got ${JSON.stringify(value)}`);
  return 'fail';
}

function parseParamDiscovery(value: string | undefined, errors: string[]): ParamDiscoveryMode {
  if (value === undefined) return 'links';
  if (value === 'links' || value === 'off') return value;
  errors.push(`"paramDiscovery" must be "links" or "off", got ${JSON.stringify(value)}`);
  return 'links';
}

function defaultLogin(): LoginConfig {
  return { type: 'none', tokenHeader: 'X-Visual-Proof-Token' };
}

function parseLogin(raw: Record<string, unknown>, errors: string[]): LoginConfig {
  const v = new Validator(raw, errors, 'login.');
  const type = v.string('type') ?? 'none';
  if (type !== 'http-hook' && type !== 'none') {
    errors.push(`"login.type" must be "http-hook" or "none", got ${JSON.stringify(type)}`);
  }
  const login: LoginConfig = {
    type: type === 'http-hook' ? 'http-hook' : 'none',
    url: v.string('url'),
    email: v.string('email'),
    tokenHeader: v.string('tokenHeader') ?? 'X-Visual-Proof-Token',
    tokenFile: v.string('tokenFile'),
  };
  if (login.type === 'http-hook') {
    if (!login.url) errors.push('"login.url" is required when login.type is "http-hook"');
    if (!login.email) errors.push('"login.email" is required when login.type is "http-hook"');
  }
  return login;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads typed fields from a raw object, recording a field-named error for each mismatch. */
class Validator {
  constructor(
    private readonly raw: Record<string, unknown>,
    private readonly errors: string[],
    private readonly prefix = '',
  ) {}

  private fail(key: string, expected: string, value: unknown): undefined {
    this.errors.push(`"${this.prefix}${key}" must be ${expected}, got ${JSON.stringify(value)}`);
    return undefined;
  }

  string(key: string): string | undefined {
    const value = this.raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value === '') return this.fail(key, 'a non-empty string', value);
    return value;
  }

  url(key: string): string | undefined {
    const value = this.string(key);
    if (value !== undefined && !isHttpUrl(value)) return this.fail(key, 'an http(s) URL', value);
    return value;
  }

  boolean(key: string): boolean | undefined {
    const value = this.raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') return this.fail(key, 'a boolean', value);
    return value;
  }

  posInt(key: string): number | undefined {
    const value = this.raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      return this.fail(key, 'a positive integer', value);
    }
    return value;
  }

  posNumber(key: string): number | undefined {
    const value = this.raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return this.fail(key, 'a positive number', value);
    }
    return value;
  }

  object(key: string): Record<string, unknown> | undefined {
    const value = this.raw[key];
    if (value === undefined) return undefined;
    if (!isRecord(value)) return this.fail(key, 'an object', value);
    return value;
  }

  stringArray(key: string): string[] | undefined {
    const value = this.raw[key];
    if (value === undefined) return undefined;
    if (!isStringArray(value)) return this.fail(key, 'an array of strings', value);
    return value;
  }

  stringMap(key: string): Record<string, string> | undefined {
    const value = this.object(key);
    if (!value) return undefined;
    if (!Object.values(value).every((x) => typeof x === 'string')) {
      return this.fail(key, 'an object of string values', value);
    }
    return value as Record<string, string>;
  }

  stringArrayMap(key: string): Record<string, string[]> | undefined {
    const value = this.object(key);
    if (!value) return undefined;
    if (!Object.values(value).every(isStringArray)) {
      return this.fail(key, 'an object of string arrays', value);
    }
    return value as Record<string, string[]>;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === 'string');
}
