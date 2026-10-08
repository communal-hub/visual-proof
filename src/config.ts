import fs from 'node:fs';
import path from 'node:path';

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

export type RenderCheckMode = 'fail' | 'warn' | 'off';

export const DEFAULT_MAX_CAPTURE_HEIGHT = 6000;
export const DEFAULT_WARMUP_BUDGET_MS = 60_000;

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
  maxFrames: number;
  finishBudgetMs: number;
  baseRef: string;
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
    maxFrames: v.posInt('maxFrames') ?? 200,
    finishBudgetMs: v.posInt('finishBudgetMs') ?? 25_000,
    baseRef: v.string('baseRef') ?? 'main',
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

function parseRenderCheck(value: string | undefined, errors: string[]): RenderCheckMode {
  if (value === undefined) return 'fail';
  if (value === 'fail' || value === 'warn' || value === 'off') return value;
  errors.push(`"renderCheck" must be "fail", "warn" or "off", got ${JSON.stringify(value)}`);
  return 'fail';
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
