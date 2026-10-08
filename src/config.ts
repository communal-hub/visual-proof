import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE_NAME = 'visual-proof.config.json';

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
  screenGlobs: string[];
  backendGlobs: string[];
  login: LoginConfig;
  appRoot: string;
  spinnerSelectors: string[];
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
    screenGlobs: v.stringArray('screenGlobs') ?? ['src/**/*.vue'],
    backendGlobs: v.stringArray('backendGlobs') ?? [],
    login,
    appRoot: v.string('appRoot') ?? '#app',
    spinnerSelectors: v.stringArray('spinnerSelectors') ?? ['.spinner', '[aria-busy=true]'],
    maxFrames: v.posInt('maxFrames') ?? 200,
    finishBudgetMs: v.posInt('finishBudgetMs') ?? 25_000,
    baseRef: v.string('baseRef') ?? 'main',
  };

  if (errors.length > 0) {
    throw new ConfigError(`${source}: invalid config\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return config;
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
