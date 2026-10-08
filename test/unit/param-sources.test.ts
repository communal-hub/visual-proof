import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { fillRoute, ParamSourceResolver, pickValue, type JsonResponse } from '../../src/resolve/param-sources.js';

describe('pickValue', () => {
  const body = {
    data: [
      { id: 7, uuid: 'abc-123', tags: ['x'], nested: { deep: { n: 2.5 } } },
      { id: 8 },
    ],
    empty: '',
    nothing: null,
    flag: true,
  };

  it('reads dot/index paths into objects and arrays', () => {
    expect(pickValue(body, 'data.0.id')).toEqual({ ok: true, value: '7' });
    expect(pickValue(body, 'data.0.uuid')).toEqual({ ok: true, value: 'abc-123' });
    expect(pickValue(body, 'data.1.id')).toEqual({ ok: true, value: '8' });
    expect(pickValue(body, 'data.0.nested.deep.n')).toEqual({ ok: true, value: '2.5' });
    expect(pickValue(body, 'data.0.tags.0')).toEqual({ ok: true, value: 'x' });
  });

  it('reads from a top-level array', () => {
    expect(pickValue([{ uuid: 'u1' }], '0.uuid')).toEqual({ ok: true, value: 'u1' });
  });

  it('takes quoted literals as they are', () => {
    expect(pickValue(body, "'invoices'")).toEqual({ ok: true, value: 'invoices' });
    expect(pickValue(null, '"tab one"')).toEqual({ ok: true, value: 'tab one' });
    expect(pickValue(body, "''")).toMatchObject({ ok: false });
  });

  it.each([
    ['data.5.id', /data has 2 item\(s\), no index 5/],
    ['data.0.nope', /data\.0 has no key "nope"/],
    ['data.id', /data is an array but "id" is not an index/],
    ['missing.0', /the response has no key "missing"/],
    ['data.0.id.more', /data\.0\.id is a number, cannot read "more"/],
    ['data.0.nested', /is an object, expected a string or number/],
    ['data.0.tags', /is an array, expected a string or number/],
    ['nothing', /is null, expected a string or number/],
    ['flag', /is a boolean, expected a string or number/],
    ['empty', /is an empty string, expected a string or number/],
    ['data..id', /empty segment/],
  ])('fails %s with a reason naming the path', (pick, reason) => {
    const result = pickValue(body, pick);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(reason);
  });

  it('does not follow the prototype chain', () => {
    expect(pickValue({}, 'constructor')).toMatchObject({ ok: false });
    expect(pickValue({}, 'toString')).toMatchObject({ ok: false });
  });
});

describe('fillRoute', () => {
  it('fills a single param from a string pick', () => {
    expect(fillRoute('/invoices/:id', { url: '/api/invoices', pick: 'data.0.id' }, { data: [{ id: 42 }] })).toEqual({
      ok: true,
      path: '/invoices/42',
    });
  });

  it('fills several params from an object pick, with literals', () => {
    const source = { url: '/api/x', pick: { id: 'data.0.id', tab: "'invoices'" } };
    expect(fillRoute('/accounts/:id/:tab', source, { data: [{ id: 'a1' }] })).toEqual({ ok: true, path: '/accounts/a1/invoices' });
  });

  it('URL-encodes picked values', () => {
    expect(fillRoute('/t/:slug', { url: '/api/t', pick: '0.slug' }, [{ slug: 'a b/c' }])).toEqual({ ok: true, path: '/t/a%20b%2Fc' });
  });

  it('names the param that failed for multi-param routes', () => {
    const result = fillRoute('/a/:id/:tab', { url: '/api', pick: { id: '0.id', tab: '0.tab' } }, [{ id: 1 }]);
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toMatch(/^param tab: /);
  });
});

describe('ParamSourceResolver', () => {
  const sources = { '/invoices/:id': { url: '/api/invoices', pick: '0.id' } };

  function fetcher(responses: Array<JsonResponse | Error>) {
    const calls: string[] = [];
    const fn = async (urlPath: string): Promise<JsonResponse> => {
      calls.push(urlPath);
      const next = responses.length > 1 ? responses.shift()! : responses[0]!;
      if (next instanceof Error) throw next;
      return next;
    };
    return { fn, calls };
  }

  it('fetches lazily and caches the result for the session', async () => {
    const f = fetcher([{ status: 200, json: [{ id: 1 }] }]);
    const resolver = new ParamSourceResolver(sources, f.fn);
    expect(f.calls).toEqual([]);
    expect(await resolver.resolve('/invoices/:id')).toEqual({ ok: true, path: '/invoices/1' });
    expect(await resolver.resolve('/invoices/:id')).toEqual({ ok: true, path: '/invoices/1' });
    expect(f.calls).toEqual(['/api/invoices']);
  });

  it('invalidate() drops the cache so the next resolve fetches again', async () => {
    const f = fetcher([{ status: 200, json: [{ id: 1 }] }, { status: 200, json: [{ id: 9 }] }]);
    const resolver = new ParamSourceResolver(sources, f.fn);
    await resolver.resolve('/invoices/:id');
    resolver.invalidate();
    expect(await resolver.resolve('/invoices/:id')).toEqual({ ok: true, path: '/invoices/9' });
    expect(f.calls).toHaveLength(2);
  });

  it('shares one fetch between concurrent resolves', async () => {
    const f = fetcher([{ status: 200, json: [{ id: 1 }] }]);
    const resolver = new ParamSourceResolver(sources, f.fn);
    await Promise.all([resolver.resolve('/invoices/:id'), resolver.resolve('/invoices/:id')]);
    expect(f.calls).toHaveLength(1);
  });

  it('does not let a fetch that started before invalidate() repopulate the cache', async () => {
    let release!: (r: JsonResponse) => void;
    const slow = new Promise<JsonResponse>((resolve) => (release = resolve));
    let n = 0;
    const resolver = new ParamSourceResolver(sources, async () => (n++ === 0 ? slow : { status: 200, json: [{ id: 2 }] }));
    const first = resolver.resolve('/invoices/:id');
    resolver.invalidate();
    release({ status: 200, json: [{ id: 1 }] });
    expect(await first).toEqual({ ok: true, path: '/invoices/1' }); // the caller that asked got its answer
    expect(await resolver.resolve('/invoices/:id')).toEqual({ ok: true, path: '/invoices/2' }); // but it was not cached
  });

  it('reports failures with the source url and does not cache them', async () => {
    const f = fetcher([{ status: 500, error: 'HTTP 500' }, { status: 200, json: [{ id: 3 }] }]);
    const resolver = new ParamSourceResolver(sources, f.fn);
    expect(await resolver.resolve('/invoices/:id')).toEqual({ ok: false, reason: 'paramSources /api/invoices failed: HTTP 500' });
    expect(await resolver.resolve('/invoices/:id')).toEqual({ ok: true, path: '/invoices/3' });
  });

  it('turns a throwing fetch, a missing path and a non-scalar value into reasons', async () => {
    const thrown = new ParamSourceResolver(sources, fetcher([new Error('socket hang up')]).fn);
    expect(await thrown.resolve('/invoices/:id')).toEqual({ ok: false, reason: 'paramSources /api/invoices failed: socket hang up' });

    const empty = new ParamSourceResolver(sources, fetcher([{ status: 200, json: [] }]).fn);
    const missing = await empty.resolve('/invoices/:id');
    expect(missing).toMatchObject({ ok: false });
    expect((missing as { reason: string }).reason).toMatch(/^paramSources \/api\/invoices: .*no index 0/);

    const objects = new ParamSourceResolver(sources, fetcher([{ status: 200, json: [{ id: { n: 1 } }] }]).fn);
    expect(((await objects.resolve('/invoices/:id')) as { reason: string }).reason).toMatch(/is an object, expected a string or number/);
  });

  it('knows which route keys it has', () => {
    const resolver = new ParamSourceResolver(sources, fetcher([{ status: 200 }]).fn);
    expect(resolver.has('/invoices/:id')).toBe(true);
    expect(resolver.has('/other/:id')).toBe(false);
    expect(resolver.has('toString')).toBe(false);
  });
});

describe('paramSources config validation', () => {
  const parse = (extra: unknown) => parseConfig({ appUrl: 'http://app.test', paramSources: extra }, '/repo', {});

  it('accepts a string pick for one param and an object pick for any number', () => {
    const config = parse({
      '/invoices/:id': { url: '/api/invoices', pick: 'data.0.id' },
      '/a/:id/:tab': { url: '/api/a', pick: { id: '0.id', tab: "'invoices'" } },
      '/b/:id': { url: '/api/b', pick: { id: '0.id' } },
    });
    expect(Object.keys(config.paramSources)).toEqual(['/invoices/:id', '/a/:id/:tab', '/b/:id']);
  });

  it('defaults to no sources', () => {
    expect(parseConfig({ appUrl: 'http://app.test' }, '/repo', {}).paramSources).toEqual({});
  });

  it.each([
    [{ '/reports': { url: '/api/x', pick: '0.id' } }, /is not a route with params/],
    [{ '/a/:id': 'nope' }, /must be an object \{ url, pick \}/],
    [{ '/a/:id': { url: 'api/x', pick: '0.id' } }, /\.url" must be an app-relative path starting with "\/"/],
    [{ '/a/:id': { url: '//evil.test/x', pick: '0.id' } }, /\.url" must be an app-relative path/],
    [{ '/a/:id': { url: 'https://evil.test/x', pick: '0.id' } }, /\.url" must be an app-relative path/],
    [{ '/a/:id': { url: '/x' } }, /\.pick" must be a string or an object/],
    [{ '/a/:id': { url: '/x', pick: '' } }, /\.pick" must not be empty/],
    [{ '/a/:id/:tab': { url: '/x', pick: '0.id' } }, /must be an object of param to pick for id, tab, got a string/],
    [{ '/a/:id/:tab': { url: '/x', pick: { id: '0.id' } } }, /missing tab/],
    [{ '/a/:id': { url: '/x', pick: { id: '0.id', other: '0.x' } } }, /other is not a param of the route/],
    [{ '/a/:id': { url: '/x', pick: { id: 3 } } }, /id is not a non-empty string/],
  ])('rejects %j', (value, message) => {
    expect(() => parse(value)).toThrow(message);
  });
});
