import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_BLOCK_HOSTS, DEFAULT_HIDE_SELECTORS, loadConfig, parseConfig } from '../../src/config.js';
import { tmpDir, write } from './helpers.js';

const dirs: string[] = [];
function project(config: unknown): string {
  const dir = tmpDir();
  dirs.push(dir);
  write(dir, 'visual-proof.config.json', typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('applies defaults when only appUrl is given', () => {
    const dir = project({ appUrl: 'http://localhost:5173' });
    const config = loadConfig({ cwd: dir, env: {} });
    expect(config).toMatchObject({
      repoDir: dir,
      appUrl: 'http://localhost:5173',
      viteUrl: 'http://localhost:5173',
      ignoreHTTPSErrors: false,
      viewport: { width: 1280, height: 800 },
      routeFiles: ['src/router/**/*.{js,ts}'],
      srcRoots: ['src'],
      aliases: { '@': 'src' },
      staticRoutes: {},
      routeParams: {},
      screenGlobs: ['src/**/*.vue'],
      ignoreScreenGlobs: [],
      backendGlobs: [],
      login: { type: 'none', tokenHeader: 'X-Visual-Proof-Token' },
      appRoot: '#app',
      spinnerSelectors: ['.spinner', '[aria-busy=true]'],
      maxFrames: 200,
      finishBudgetMs: 25_000,
      baseRef: 'main',
    });
    expect(config.freshnessMarker).toBeUndefined();
    expect(config.routeParamsFile).toBeUndefined();
  });

  it('keeps explicit values and defaults viteUrl to appUrl only when absent', () => {
    const dir = project({
      appUrl: 'https://app.test',
      viteUrl: 'http://localhost:5173',
      freshnessMarker: 'public/hot',
      viewport: { width: 800 },
      login: { type: 'http-hook', url: '/__playwright__/login', email: 'a@b.test', tokenFile: '.visual-proof/token' },
      maxFrames: 5,
    });
    const config = loadConfig({ cwd: dir, env: {} });
    expect(config.viteUrl).toBe('http://localhost:5173');
    expect(config.freshnessMarker).toBe('public/hot');
    expect(config.viewport).toEqual({ width: 800, height: 800 });
    expect(config.login).toEqual({
      type: 'http-hook',
      url: '/__playwright__/login',
      email: 'a@b.test',
      tokenHeader: 'X-Visual-Proof-Token',
      tokenFile: '.visual-proof/token',
    });
    expect(config.maxFrames).toBe(5);
  });

  it('reads routeParamsFile and rejects a non-string', () => {
    expect(loadConfig({ cwd: project({ appUrl: 'http://a.test', routeParamsFile: '.visual-proof/params.json' }), env: {} }).routeParamsFile).toBe(
      '.visual-proof/params.json',
    );
    expect(() => loadConfig({ cwd: project({ appUrl: 'http://a.test', routeParamsFile: 3 }), env: {} })).toThrow(
      /"routeParamsFile" must be a non-empty string/,
    );
  });

  it('reads ignoreScreenGlobs and rejects a non-array', () => {
    expect(loadConfig({ cwd: project({ appUrl: 'http://a.test', ignoreScreenGlobs: ['src/stories/**'] }), env: {} }).ignoreScreenGlobs).toEqual([
      'src/stories/**',
    ]);
    expect(() => loadConfig({ cwd: project({ appUrl: 'http://a.test', ignoreScreenGlobs: 'src/**' }), env: {} })).toThrow(
      /"ignoreScreenGlobs" must be an array of strings/,
    );
  });

  it('loads from an explicit --config path and sets repoDir to its directory', () => {
    const dir = project({ appUrl: 'http://localhost:1' });
    fs.mkdirSync(path.join(dir, 'conf'));
    fs.renameSync(path.join(dir, 'visual-proof.config.json'), path.join(dir, 'conf', 'custom.json'));
    const config = loadConfig({ cwd: dir, configPath: 'conf/custom.json', env: {} });
    expect(config.repoDir).toBe(path.join(dir, 'conf'));
  });

  it('names the missing appUrl field', () => {
    const dir = project({});
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(ConfigError);
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/"appUrl" is required/);
  });

  it('reports bad JSON with the file name', () => {
    const dir = project('{ nope');
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/invalid JSON/);
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/visual-proof\.config\.json/);
  });

  it('reports a missing file', () => {
    const dir = tmpDir();
    dirs.push(dir);
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/config file not found/);
  });

  it('rejects non-object top level', () => {
    const dir = project('[]');
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/must be a JSON object/);
  });

  it('collects every field error, naming each field', () => {
    const dir = project({
      appUrl: 'not a url',
      maxFrames: 0,
      routeFiles: 'src/**',
      aliases: { '@': 1 },
      viewport: { width: -1 },
      login: { type: 'oauth' },
    });
    let message = '';
    try {
      loadConfig({ cwd: dir, env: {} });
    } catch (err) {
      message = (err as Error).message;
    }
    for (const field of ['"appUrl"', '"maxFrames"', '"routeFiles"', '"aliases"', '"viewport.width"', '"login.type"']) {
      expect(message).toContain(field);
    }
  });

  it('requires url and email for the http-hook login', () => {
    const dir = project({ appUrl: 'http://x.test', login: { type: 'http-hook' } });
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/"login\.url" is required/);
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/"login\.email" is required/);
  });

  it('validates staticRoutes shape', () => {
    const dir = project({ appUrl: 'http://x.test', staticRoutes: { 'a.vue': '/a' } });
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/"staticRoutes"/);
  });

  describe('env overrides', () => {
    it('lets VISUAL_PROOF_APP_URL and VISUAL_PROOF_VITE_URL override the file', () => {
      const dir = project({ appUrl: 'http://file.test', viteUrl: 'http://file-vite.test' });
      const config = loadConfig({
        cwd: dir,
        env: { VISUAL_PROOF_APP_URL: 'https://env.test', VISUAL_PROOF_VITE_URL: 'http://localhost:9' },
      });
      expect(config.appUrl).toBe('https://env.test');
      expect(config.viteUrl).toBe('http://localhost:9');
    });

    it('satisfies the appUrl requirement', () => {
      const dir = project({});
      expect(loadConfig({ cwd: dir, env: { VISUAL_PROOF_APP_URL: 'http://env.test' } }).appUrl).toBe(
        'http://env.test',
      );
    });

    it('rejects an invalid env URL by name', () => {
      const dir = project({ appUrl: 'http://file.test' });
      expect(() => loadConfig({ cwd: dir, env: { VISUAL_PROOF_APP_URL: 'nope' } })).toThrow(
        /VISUAL_PROOF_APP_URL/,
      );
    });

    it('viteUrl follows an env appUrl override when not set', () => {
      const dir = project({ appUrl: 'http://file.test' });
      expect(loadConfig({ cwd: dir, env: { VISUAL_PROOF_APP_URL: 'http://env.test' } }).viteUrl).toBe(
        'http://env.test',
      );
    });
  });
});

describe('parseConfig', () => {
  it('works on an in-memory object', () => {
    expect(parseConfig({ appUrl: 'http://x.test' }, '/repo', {}).repoDir).toBe('/repo');
  });
});

describe('capture-quality fields (v0.3)', () => {
  const base = { appUrl: 'http://localhost:5173' };
  const parse = (extra: Record<string, unknown> = {}) => parseConfig({ ...base, ...extra }, '/repo', {});

  it('has defaults', () => {
    const config = parse();
    expect(config).toMatchObject({ warmupBudgetMs: 60_000, maxCaptureHeight: 6000, renderCheck: 'fail' });
    expect(config.warmupRoutes).toBeUndefined();
    expect(config.scrollContainer).toBeUndefined();
    expect(config.hideSelectors).toEqual([...DEFAULT_HIDE_SELECTORS]);
  });

  it('never hides the Vite error overlay or every element carrying data-v-inspector', () => {
    const joined = DEFAULT_HIDE_SELECTORS.join(' ');
    expect(joined).not.toContain('vite-error-overlay');
    expect(joined).not.toContain('[data-v-inspector]');
  });

  it('extends the default hide selectors, deduplicated, or replaces them', () => {
    const extended = parse({ hideSelectors: ['.cookie-banner', '.vue-devtools__anchor'] }).hideSelectors;
    expect(extended).toEqual([...DEFAULT_HIDE_SELECTORS, '.cookie-banner']);
    expect(parse({ hideSelectors: ['.only'], hideSelectorsReplace: true }).hideSelectors).toEqual(['.only']);
    expect(parse({ hideSelectorsReplace: true }).hideSelectors).toEqual([]);
  });

  it('reads the warm-up, scroll and cap fields', () => {
    expect(parse({ warmupRoutes: ['/', '/a/:id'], warmupBudgetMs: 5000, scrollContainer: 'main.app', maxCaptureHeight: 3000 })).toMatchObject({
      warmupRoutes: ['/', '/a/:id'],
      warmupBudgetMs: 5000,
      scrollContainer: 'main.app',
      maxCaptureHeight: 3000,
    });
    expect(parse({ warmupRoutes: [] }).warmupRoutes).toEqual([]);
  });

  it('reads renderCheck and rejects anything else', () => {
    for (const mode of ['fail', 'warn', 'off']) expect(parse({ renderCheck: mode }).renderCheck).toBe(mode);
    expect(() => parse({ renderCheck: 'maybe' })).toThrow('"renderCheck" must be "fail", "warn" or "off", got "maybe"');
  });

  describe('flake controls and settle (v0.4)', () => {
    it('defaults: no fixed time, no masks, the tracker block list, 250 ms idle (capped at 5 s)', () => {
      const config = parse({});
      expect(config.fixedTime).toBeUndefined();
      expect(config.maskSelectors).toEqual([]);
      expect(config.blockHosts).toEqual([...DEFAULT_BLOCK_HOSTS]);
      expect(config.allowHosts).toEqual([]);
      expect(config.settle).toEqual({ networkIdleMs: 250, maxWaitMs: 5000 });
    });

    it('keeps the default block list to analytics and trackers: no payments, maps or fonts', () => {
      expect([...DEFAULT_BLOCK_HOSTS]).toEqual([
        '*.google-analytics.com',
        '*.googletagmanager.com',
        '*.posthog.com',
        '*.segment.io',
        '*.hotjar.com',
        '*.intercom.io',
        '*.sentry.io',
      ]);
    });

    it('reads fixedTime, maskSelectors, blockHosts, allowHosts and settle', () => {
      const config = parse({
        fixedTime: '2026-01-15T09:00:00Z',
        maskSelectors: ['[data-test=clock]', 'text=Updated'],
        blockHosts: ['*.ads.example'],
        allowHosts: ['js.ads.example'],
        settle: { networkIdleMs: 300 },
      });
      expect(config).toMatchObject({
        fixedTime: '2026-01-15T09:00:00Z',
        maskSelectors: ['[data-test=clock]', 'text=Updated'],
        blockHosts: ['*.ads.example'],
        allowHosts: ['js.ads.example'],
        settle: { networkIdleMs: 300, maxWaitMs: 5000 },
      });
    });

    it('a configured blockHosts replaces the defaults, and [] turns blocking off', () => {
      expect(parse({ blockHosts: [] }).blockHosts).toEqual([]);
      expect(parse({ blockHosts: ['x.test'] }).blockHosts).toEqual(['x.test']);
    });

    it.each([
      [{ fixedTime: 'yesterday' }, /"fixedTime" must be an ISO 8601 timestamp/],
      [{ fixedTime: '2026-13-45' }, /"fixedTime" must be an ISO 8601 timestamp/],
      [{ blockHosts: ['https://x.test'] }, /"blockHosts" entries must be hostname globs/],
      [{ allowHosts: ['x.test/path'] }, /"allowHosts" entries must be hostname globs/],
      [{ blockHosts: ['x.test:8080'] }, /"blockHosts" entries must be hostname globs/],
      [{ settle: { networkIdleMs: 0 } }, /"settle.networkIdleMs" must be a positive integer/],
      [{ settle: { maxWaitMs: 'long' } }, /"settle.maxWaitMs" must be a positive integer/],
      [{ settle: 5 }, /"settle" must be an object/],
      [{ maskSelectors: 'h1' }, /"maskSelectors" must be an array of strings/],
    ])('rejects %j', (value, message) => {
      expect(() => parse(value)).toThrow(message);
    });
  });

  it('rejects wrong types', () => {
    const message = (() => {
      try {
        parse({ warmupRoutes: '/', maxCaptureHeight: -1, hideSelectorsReplace: 'yes', scrollContainer: '' });
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    })();
    for (const expected of [
      '"warmupRoutes" must be an array of strings',
      '"maxCaptureHeight" must be a positive integer',
      '"hideSelectorsReplace" must be a boolean',
      '"scrollContainer" must be a non-empty string',
    ]) {
      expect(message).toContain(expected);
    }
  });
});
