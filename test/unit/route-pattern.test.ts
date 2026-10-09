import { describe, expect, it } from 'vitest';
import {
  buildPath,
  hasParams,
  matchRoute,
  moreSpecificRoute,
  nearestParent,
  needsParams,
  parseRoutePattern,
  requiredParams,
  routeRegex,
  specificity,
} from '../../src/resolve/route-pattern.js';

describe('parseRoutePattern', () => {
  it('reads static segments and plain params', () => {
    const parsed = parseRoutePattern('/invoices/:id');
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.pattern.params).toEqual([{ kind: 'param', name: 'id', regex: null, optional: false, repeat: false }]);
    expect(parsed.pattern.segmentTexts).toEqual(['invoices', ':id']);
  });

  it('reads a custom regex, with nested groups, classes and escapes inside it', () => {
    const parsed = parseRoutePattern('/users/:id(\\d+)/files/:name([a-z]+(?:\\.[a-z]+)?)');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.pattern.params.map((p) => [p.name, p.regex])).toEqual([
      ['id', '\\d+'],
      ['name', '[a-z]+(?:\\.[a-z]+)?'],
    ]);
  });

  it('reads the ?, + and * modifiers', () => {
    const parsed = parseRoutePattern('/a/:one?/:many+/:any*');
    expect(parsed.ok && parsed.pattern.params.map((p) => [p.name, p.optional, p.repeat])).toEqual([
      ['one', true, false],
      ['many', false, true],
      ['any', true, true],
    ]);
  });

  it.each([
    ['/a/:id(\\d+', /unbalanced/],
    ['/a/:id()', /empty custom regex/],
    ['/a/:id([)', /invalid regex|unbalanced/],
    ['/a/:id/b/:id', /appears twice/],
    ['/a/x-:rest+', /repeatable param/],
  ])('rejects %s', (raw, reason) => {
    const parsed = parseRoutePattern(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(reason);
  });

  it('knows which patterns have params and which of them are required', () => {
    expect(hasParams('/a/b')).toBe(false);
    expect(hasParams('/a/:b?')).toBe(true);
    expect(needsParams('/a/:b?')).toBe(false);
    expect(needsParams('/a/:b')).toBe(true);
    expect(requiredParams('/a/:b/:c?/:d*')).toEqual(['b']);
  });
});

describe('routeRegex / matchRoute', () => {
  it('matches a plain param against exactly one segment, case-insensitively, with an optional trailing slash', () => {
    expect(matchRoute('/invoices/:id', '/invoices/42')).toEqual({ id: '42' });
    expect(matchRoute('/invoices/:id', '/Invoices/42/')).toEqual({ id: '42' });
    expect(matchRoute('/invoices/:id', '/invoices')).toBeNull();
    expect(matchRoute('/invoices/:id', '/invoices/42/edit')).toBeNull();
    expect(matchRoute('/invoices/:id', '/other/42')).toBeNull();
  });

  it('honours a custom regex', () => {
    expect(matchRoute('/users/:id(\\d+)', '/users/17')).toEqual({ id: '17' });
    expect(matchRoute('/users/:id(\\d+)', '/users/me')).toBeNull();
    expect(matchRoute('/users/:id(\\d+)', '/users/17a')).toBeNull();
    expect(matchRoute('/p/:kind(a|b)/:n(\\d{2})', '/p/b/07')).toEqual({ kind: 'b', n: '07' });
  });

  it('treats ? as optional including the slash, and + / * as repeatable segments', () => {
    expect(matchRoute('/docs/:slug?', '/docs')).toEqual({});
    expect(matchRoute('/docs/:slug?', '/docs/intro')).toEqual({ slug: 'intro' });
    expect(matchRoute('/docs/:slug?', '/docs/a/b')).toBeNull();
    expect(matchRoute('/files/:path+', '/files')).toBeNull();
    expect(matchRoute('/files/:path+', '/files/a')).toEqual({ path: 'a' });
    expect(matchRoute('/files/:path+', '/files/a/b/c')).toEqual({ path: 'a/b/c' });
    expect(matchRoute('/files/:path*', '/files')).toEqual({});
    expect(matchRoute('/files/:path*', '/files/a/b')).toEqual({ path: 'a/b' });
    expect(matchRoute('/:pathMatch(.*)*', '/anything/at/all')).toEqual({ pathMatch: 'anything/at/all' });
  });

  it('matches nested params', () => {
    expect(matchRoute('/clubs/:clubId/teams/:teamId', '/clubs/1/teams/10')).toEqual({ clubId: '1', teamId: '10' });
    expect(matchRoute('/clubs/:clubId/teams/:teamId', '/clubs/1/teams')).toBeNull();
  });

  it('matches params inside a segment next to static text, and escapes regex characters in static text', () => {
    expect(matchRoute('/file-:id.json', '/file-9.json')).toEqual({ id: '9' });
    expect(matchRoute('/v1.0/:id', '/v1.0/3')).toEqual({ id: '3' });
    expect(matchRoute('/v1.0/:id', '/v1x0/3')).toBeNull();
  });

  it('matches the root and static routes', () => {
    expect(routeRegex('/')!.test('/')).toBe(true);
    expect(matchRoute('/reports', '/reports')).toEqual({});
    expect(matchRoute('/reports', '/reports/1')).toBeNull();
  });

  it('is null for a pattern it cannot parse', () => {
    expect(routeRegex('/a/:id(')).toBeNull();
    expect(matchRoute('/a/:id(', '/a/1')).toBeNull();
  });
});

describe('buildPath', () => {
  it('fills a plain param and encodes the value', () => {
    expect(buildPath('/invoices/:id', { id: '5' })).toEqual({ ok: true, path: '/invoices/5' });
    expect(buildPath('/tags/:name', { name: 'a b&c' })).toEqual({ ok: true, path: '/tags/a%20b%26c' });
  });

  it('fills nested params', () => {
    expect(buildPath('/clubs/:clubId/teams/:teamId', { clubId: '1', teamId: '10' })).toEqual({ ok: true, path: '/clubs/1/teams/10' });
  });

  it('names the missing params', () => {
    expect(buildPath('/clubs/:clubId/teams/:teamId', { clubId: '1' })).toEqual({ ok: false, reason: '/clubs/:clubId/teams/:teamId needs teamId' });
    expect(buildPath('/invoices/:id', {})).toMatchObject({ ok: false, reason: expect.stringContaining('needs id') });
  });

  it('names the extra params', () => {
    const built = buildPath('/invoices/:id', { id: '1', slug: 'x' });
    expect(built).toMatchObject({ ok: false });
    expect(!built.ok && built.reason).toContain('has no param slug');
    expect(!built.ok && built.reason).toContain('params: id');
    const none = buildPath('/reports', { id: '1' });
    expect(!none.ok && none.reason).toContain('it has no params');
  });

  it('checks a value against the custom regex', () => {
    expect(buildPath('/users/:id(\\d+)', { id: '17' })).toEqual({ ok: true, path: '/users/17' });
    const bad = buildPath('/users/:id(\\d+)', { id: 'abc' });
    expect(!bad.ok && bad.reason).toBe('id="abc" does not fit (\\d+)');
  });

  it('rejects a slash in a plain param, and an empty value', () => {
    const slash = buildPath('/invoices/:id', { id: 'a/b' });
    expect(!slash.ok && slash.reason).toContain('must not contain "/"');
    const empty = buildPath('/invoices/:id', { id: '' });
    expect(!empty.ok && empty.reason).toContain('must not be empty');
  });

  it('leaves optional params out, and repeats a repeatable one', () => {
    expect(buildPath('/docs/:slug?', {})).toEqual({ ok: true, path: '/docs' });
    expect(buildPath('/docs/:slug?', { slug: 'intro' })).toEqual({ ok: true, path: '/docs/intro' });
    expect(buildPath('/files/:path+', { path: 'a/b c' })).toEqual({ ok: true, path: '/files/a/b%20c' });
    expect(buildPath('/', {})).toEqual({ ok: true, path: '/' });
  });

  it('round-trips through matchRoute', () => {
    for (const [pattern, values] of [
      ['/clubs/:clubId/teams/:teamId', { clubId: '1', teamId: '10' }],
      ['/users/:id(\\d+)', { id: '17' }],
      ['/files/:path+', { path: 'a/b' }],
    ] as const) {
      const built = buildPath(pattern, values);
      expect(built.ok && matchRoute(pattern, built.path)).toEqual(values);
    }
  });
});

describe('nearestParent', () => {
  const known = ['/', '/invoices', '/invoices/:id', '/clubs', '/clubs/:clubId/teams', '/clubs/:clubId/teams/:teamId'];

  it('is the route one segment up', () => {
    expect(nearestParent('/invoices/:id', known)).toBe('/invoices');
    expect(nearestParent('/clubs/:clubId/teams/:teamId', known)).toBe('/clubs/:clubId/teams');
  });

  it('skips ancestors that are not routes', () => {
    expect(nearestParent('/clubs/:clubId/teams', known)).toBe('/clubs');
    expect(nearestParent('/a/b/:id', ['/', '/a'])).toBe('/a');
  });

  it('falls back to the root route when it is one, and is null when no ancestor is a route', () => {
    expect(nearestParent('/orphan/:id', known)).toBe('/');
    expect(nearestParent('/orphan/:id', ['/invoices'])).toBeNull();
    expect(nearestParent('/', known)).toBeNull();
  });

  it('keeps a parent that carries a custom regex whole', () => {
    expect(nearestParent('/u/:id(\\d+)/posts/:post', ['/u/:id(\\d+)/posts'])).toBe('/u/:id(\\d+)/posts');
  });

  it('never returns the route itself, and gives up on an unparseable pattern', () => {
    expect(nearestParent('/invoices/:id', ['/invoices/:id'])).toBeNull();
    expect(nearestParent('/a/:id(', ['/a'])).toBeNull();
  });
});

describe('specificity / moreSpecificRoute', () => {
  it('counts the fully static segments', () => {
    expect(specificity('/invoices/create')).toBe(2);
    expect(specificity('/invoices/:id')).toBe(1);
    expect(specificity('/:pathMatch(.*)*')).toBe(0);
  });

  it('finds the static sibling a param route would swallow', () => {
    const known = ['/invoices', '/invoices/:id', '/invoices/create'];
    expect(moreSpecificRoute('/invoices/:id', '/invoices/create', known)).toBe('/invoices/create');
    expect(moreSpecificRoute('/invoices/:id', '/invoices/42', known)).toBeNull();
  });

  it('ignores less specific routes such as a catch-all', () => {
    expect(moreSpecificRoute('/invoices/:id', '/invoices/42', ['/:pathMatch(.*)*'])).toBeNull();
  });
});
