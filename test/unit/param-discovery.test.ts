import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chooseLink,
  MAX_DISCOVERY_DEPTH,
  ParamDiscoverer,
  readDiscoveryCache,
  writeDiscoveryCache,
  type CollectLinks,
  type DiscoveryDeps,
  type LinkPage,
} from '../../src/resolve/param-discovery.js';
import { tmpDir } from './helpers.js';

const APP = 'http://app.test';
const ROUTES = ['/', '/invoices', '/invoices/create', '/invoices/:id', '/clubs', '/clubs/:clubId/teams', '/clubs/:clubId/teams/:teamId'];

describe('chooseLink', () => {
  it('takes the first href that fits the pattern, in DOM order', () => {
    const hrefs = [`${APP}/`, `${APP}/invoices`, `${APP}/invoices/7`, `${APP}/invoices/3`];
    expect(chooseLink(hrefs, '/invoices/:id', APP, ROUTES).path).toBe('/invoices/7');
  });

  it('skips other origins, other schemes and links that do not fit', () => {
    const hrefs = ['https://example.com/invoices/1', 'mailto:a@b.test', 'javascript:void(0)', `${APP}/reports/9`, `${APP}/invoices/8`];
    const choice = chooseLink(hrefs, '/invoices/:id', APP, ROUTES);
    expect(choice.path).toBe('/invoices/8');
    expect(choice.sameOrigin).toBe(2);
  });

  it('normalises to a path: no query, hash or trailing slash', () => {
    expect(chooseLink([`${APP}/invoices/5/?tab=x#top`], '/invoices/:id', APP, ROUTES).path).toBe('/invoices/5');
    expect(chooseLink(['/invoices/6'], '/invoices/:id', APP, ROUTES).path).toBe('/invoices/6');
  });

  it('strips the base path of an app mounted under one, and ignores links outside it', () => {
    const base = 'http://app.test/app';
    expect(chooseLink(['http://app.test/invoices/1', 'http://app.test/app/invoices/2'], '/invoices/:id', base, ROUTES).path).toBe('/invoices/2');
  });

  it('skips a candidate that is really a more specific static route, and says so', () => {
    const choice = chooseLink([`${APP}/invoices/create`, `${APP}/invoices/4`], '/invoices/:id', APP, ROUTES);
    expect(choice.path).toBe('/invoices/4');
    expect(choice.skipped).toEqual([{ path: '/invoices/create', route: '/invoices/create' }]);
    const only = chooseLink([`${APP}/invoices/create`], '/invoices/:id', APP, ROUTES);
    expect(only.path).toBeUndefined();
    expect(only.skipped).toHaveLength(1);
  });

  it('honours custom regex, optional and repeatable params', () => {
    expect(chooseLink([`${APP}/u/me`, `${APP}/u/15`], '/u/:id(\\d+)', APP, []).path).toBe('/u/15');
    expect(chooseLink([`${APP}/docs`], '/docs/:slug?', APP, []).path).toBe('/docs');
    expect(chooseLink([`${APP}/files/a/b`], '/files/:path+', APP, []).path).toBe('/files/a/b');
  });

  it('has nothing for an unparseable pattern or an empty page', () => {
    expect(chooseLink([`${APP}/x/1`], '/x/:id(', APP, []).path).toBeUndefined();
    expect(chooseLink([], '/x/:id', APP, []).path).toBeUndefined();
  });
});

/** A site map: path -> hrefs (absolute or relative). A path missing from the map answers with an error. */
function site(pages: Record<string, string[] | { error: string } | { finalUrl: string; hrefs: string[] }>): { collect: CollectLinks; loaded: string[] } {
  const loaded: string[] = [];
  const collect: CollectLinks = async (url) => {
    const p = new URL(url).pathname;
    loaded.push(p);
    const page = pages[p];
    if (page === undefined) return { ok: false, hrefs: [], error: 'HTTP 404', ms: 1 } satisfies LinkPage;
    if (Array.isArray(page)) return { ok: true, hrefs: page, ms: 1 };
    if ('error' in page) return { ok: false, hrefs: [], error: page.error, ms: 1 };
    return { ok: true, hrefs: page.hrefs, finalUrl: page.finalUrl, ms: 1 };
  };
  return { collect, loaded };
}

function discoverer(collect: CollectLinks, extra: Partial<DiscoveryDeps> = {}): ParamDiscoverer {
  const d: ParamDiscoverer = new ParamDiscoverer({
    appUrl: APP,
    collect,
    routes: async () => ROUTES,
    // The watcher chains every tier; here an ancestor with params can only be discovered itself.
    fillParent: async (key, depth) => {
      const out = await d.discover(key, depth);
      return out.ok ? { ok: true, path: out.path } : { ok: false, reason: out.reason };
    },
    ...extra,
  });
  return d;
}

describe('ParamDiscoverer', () => {
  it('loads the parent route and takes the first matching link', async () => {
    const { collect, loaded } = site({ '/invoices': ['/', '/invoices/create', '/invoices/12', '/invoices/13'] });
    const out = await discoverer(collect).discover('/invoices/:id');
    expect(out).toMatchObject({ ok: true, path: '/invoices/12', foundOn: '/invoices', cached: false });
    expect(loaded).toEqual(['/invoices']);
  });

  it('caches a success for the session, and invalidate() drops it', async () => {
    const pages: Record<string, string[]> = { '/invoices': ['/invoices/12'] };
    const { collect, loaded } = site(pages);
    const d = discoverer(collect);
    await d.discover('/invoices/:id');
    expect(await d.discover('/invoices/:id')).toMatchObject({ ok: true, path: '/invoices/12', cached: true });
    expect(loaded).toEqual(['/invoices']);

    pages['/invoices'] = ['/invoices/30'];
    d.invalidate();
    expect(d.entries()).toEqual({});
    expect(await d.discover('/invoices/:id')).toMatchObject({ ok: true, path: '/invoices/30', cached: false });
    expect(loaded).toEqual(['/invoices', '/invoices']);
  });

  it('mirrors its cache through onCacheChange', async () => {
    const seen: Array<string[]> = [];
    const { collect } = site({ '/invoices': ['/invoices/12'] });
    const d = discoverer(collect, { onCacheChange: (entries) => seen.push(Object.keys(entries)) });
    await d.discover('/invoices/:id');
    d.invalidate();
    expect(seen).toEqual([['/invoices/:id'], []]);
  });

  it('does not repopulate the cache from a lookup that started before an invalidate()', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const collect: CollectLinks = async () => {
      await gate;
      return { ok: true, hrefs: ['/invoices/1'], ms: 1 };
    };
    const d = discoverer(collect);
    const pending = d.discover('/invoices/:id');
    d.invalidate();
    release();
    expect(await pending).toMatchObject({ ok: true });
    expect(d.entries()).toEqual({});
  });

  it('shares one lookup between concurrent requests, and does not cache a failure', async () => {
    const { collect, loaded } = site({ '/invoices': [] });
    const d = discoverer(collect);
    const [a, b] = await Promise.all([d.discover('/invoices/:id'), d.discover('/invoices/:id')]);
    expect(a).toEqual(b);
    expect(loaded).toEqual(['/invoices']);
    await d.discover('/invoices/:id');
    expect(loaded).toEqual(['/invoices', '/invoices']);
  });

  it('fails with the page it looked at when no link fits', async () => {
    const { collect } = site({ '/invoices': ['/', '/reports', 'https://example.com/invoices/1'] });
    expect(await discoverer(collect).discover('/invoices/:id')).toMatchObject({ ok: false, reason: 'no link matching /invoices/:id on /invoices' });
  });

  it('adds what it saw when that explains the miss: no links, a static sibling, a redirect', async () => {
    expect(await discoverer(site({ '/invoices': [] }).collect).discover('/invoices/:id')).toMatchObject({
      reason: 'no link matching /invoices/:id on /invoices (the page has no links)',
    });
    expect(await discoverer(site({ '/invoices': ['/invoices/create'] }).collect).discover('/invoices/:id')).toMatchObject({
      reason: 'no link matching /invoices/:id on /invoices (skipped /invoices/create (route /invoices/create))',
    });
    expect(await discoverer(site({ '/invoices': { finalUrl: `${APP}/login`, hrefs: ['/help'] } }).collect).discover('/invoices/:id')).toMatchObject({
      reason: 'no link matching /invoices/:id on /invoices (the page ended on /login)',
    });
  });

  it('fails when the parent cannot be loaded', async () => {
    expect(await discoverer(site({ '/invoices': { error: 'HTTP 500' } }).collect).discover('/invoices/:id')).toMatchObject({
      ok: false,
      reason: 'could not load /invoices: HTTP 500',
    });
    const throwing: CollectLinks = async () => {
      throw new Error('browser died\nstack');
    };
    expect(await discoverer(throwing).discover('/invoices/:id')).toMatchObject({ reason: 'could not load /invoices: browser died' });
  });

  it('fails when the route has no parent route, or its pattern is not supported', async () => {
    const { collect, loaded } = site({});
    expect(await discoverer(collect, { routes: async () => ['/invoices/:id'] }).discover('/invoices/:id')).toMatchObject({ reason: 'no parent route for /invoices/:id' });
    expect(await discoverer(collect).discover('/x/:id(')).toMatchObject({ ok: false, reason: expect.stringContaining('route pattern not supported') });
    expect(await discoverer(collect, { routes: async () => { throw new Error('no graph'); } }).discover('/invoices/:id')).toMatchObject({ reason: 'route table unavailable: no graph' });
    expect(loaded).toEqual([]);
  });

  it('fills a parent that has params first, recursing through discovery', async () => {
    const { collect, loaded } = site({
      '/clubs': ['/clubs/2/teams', '/clubs/3/teams'],
      '/clubs/2/teams': ['/clubs/2/teams/21'],
    });
    const out = await discoverer(collect).discover('/clubs/:clubId/teams/:teamId');
    expect(out).toMatchObject({ ok: true, path: '/clubs/2/teams/21', foundOn: '/clubs/2/teams' });
    expect(loaded).toEqual(['/clubs', '/clubs/2/teams']);
  });

  it('reports a parent that could not be filled', async () => {
    const { collect } = site({ '/clubs': [] });
    expect(await discoverer(collect).discover('/clubs/:clubId/teams/:teamId')).toMatchObject({
      ok: false,
      reason: 'parent /clubs/:clubId/teams has no params: no link matching /clubs/:clubId/teams on /clubs (the page has no links)',
    });
  });

  it('stops at the depth limit', async () => {
    const chain = ['/', '/a', '/a/:b', '/a/:b/c/:d', '/a/:b/c/:d/e/:f', '/a/:b/c/:d/e/:f/g/:h', '/a/:b/c/:d/e/:f/g/:h/i/:j'];
    const pages: Record<string, string[]> = {
      '/a': ['/a/1'],
      '/a/1': ['/a/1/c/2'],
      '/a/1/c/2': ['/a/1/c/2/e/3'],
      '/a/1/c/2/e/3': ['/a/1/c/2/e/3/g/4'],
    };
    const { collect } = site(pages);
    const routes = async () => chain;
    // Three ancestors that need filling (depth 1, 2, 3) are fine...
    const ok = await discoverer(collect, { routes }).discover('/a/:b/c/:d/e/:f/g/:h');
    expect(ok).toMatchObject({ ok: true, path: '/a/1/c/2/e/3/g/4' });
    // ...a fourth is one too many.
    const tooDeep = await discoverer(collect, { routes }).discover('/a/:b/c/:d/e/:f/g/:h/i/:j');
    expect(tooDeep.ok).toBe(false);
    expect(!tooDeep.ok && tooDeep.reason).toContain(`discovery depth limit (${MAX_DISCOVERY_DEPTH}) is reached`);
  });

  it('writes and reads the cache file', () => {
    const file = path.join(tmpDir('vp-disc-'), 'param-discovery.json');
    expect(readDiscoveryCache(file)).toBeNull();
    writeDiscoveryCache(file, 's-1', { '/a/:id': { path: '/a/1', foundOn: '/a', at: 'now' } });
    expect(readDiscoveryCache(file)).toEqual({ sessionId: 's-1', routes: { '/a/:id': { path: '/a/1', foundOn: '/a', at: 'now' } } });
  });
});
