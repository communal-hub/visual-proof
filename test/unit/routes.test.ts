import { describe, expect, it } from 'vitest';
import type { ImportGraph } from '../../src/resolve/import-graph.js';
import { concretePath, joinUrl, resolveRoutes } from '../../src/resolve/routes.js';

function graphOf(map: Record<string, string[]>): ImportGraph {
  return { fileToRoutes: new Map(Object.entries(map)), routes: [], unresolved: [] };
}

const base = { appUrl: 'http://localhost:5173', staticRoutes: {}, routeParams: {} };

describe('resolveRoutes', () => {
  it('maps changed files through the import graph', () => {
    const graph = graphOf({ 'src/Shared.vue': ['/', '/about'], 'src/About.vue': ['/about'] });
    const result = resolveRoutes(['src/Shared.vue', 'src/About.vue'], graph, base);
    expect(result.routes).toEqual([
      { routeKey: '/', path: '/', url: 'http://localhost:5173/', sourceFiles: ['src/Shared.vue'] },
      {
        routeKey: '/about',
        path: '/about',
        url: 'http://localhost:5173/about',
        sourceFiles: ['src/About.vue', 'src/Shared.vue'],
      },
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.unmapped).toEqual([]);
  });

  it('falls back to staticRoutes only for files the graph does not know', () => {
    const graph = graphOf({ 'src/Known.vue': ['/known'] });
    const result = resolveRoutes(['src/Known.vue', 'src/Reports.vue'], graph, {
      ...base,
      staticRoutes: { 'src/Reports.vue': ['/reports'], 'src/Known.vue': ['/ignored'] },
    });
    expect(result.routes.map((r) => r.routeKey)).toEqual(['/known', '/reports']);
  });

  it('reports files that neither source maps, instead of dropping them silently', () => {
    const result = resolveRoutes(['src/Nowhere.vue'], graphOf({}), base);
    expect(result.routes).toEqual([]);
    expect(result.unmapped).toEqual(['src/Nowhere.vue']);
  });

  it('applies routeParams to param routes', () => {
    const graph = graphOf({ 'src/Invoice.vue': ['/invoices/:id'] });
    const result = resolveRoutes(['src/Invoice.vue'], graph, {
      ...base,
      routeParams: { '/invoices/:id': '/invoices/1' },
    });
    expect(result.routes).toEqual([
      {
        routeKey: '/invoices/:id',
        path: '/invoices/1',
        url: 'http://localhost:5173/invoices/1',
        sourceFiles: ['src/Invoice.vue'],
      },
    ]);
  });

  it('skips param routes with no routeParams entry, with a reason', () => {
    const graph = graphOf({ 'src/Invoice.vue': ['/invoices/:id', '/'] });
    const result = resolveRoutes(['src/Invoice.vue'], graph, base);
    expect(result.routes.map((r) => r.routeKey)).toEqual(['/']);
    expect(result.skipped).toEqual([
      {
        routeKey: '/invoices/:id',
        reason: 'no routeParams entry for /invoices/:id (params: :id)',
        sourceFiles: ['src/Invoice.vue'],
      },
    ]);
  });

  it('keeps appUrl base paths', () => {
    const graph = graphOf({ 'a.vue': ['/a'] });
    const result = resolveRoutes(['a.vue'], graph, { ...base, appUrl: 'https://x.test/app/' });
    expect(result.routes[0]!.url).toBe('https://x.test/app/a');
  });

  it('returns nothing for no files', () => {
    expect(resolveRoutes([], graphOf({}), base)).toEqual({ routes: [], skipped: [], unmapped: [] });
  });
});

describe('concretePath', () => {
  it('passes static routes through', () => {
    expect(concretePath('/about', {})).toEqual({ ok: true, path: '/about' });
  });

  it('lists every unfilled param', () => {
    const result = concretePath('/orgs/:org/invoices/:id', {});
    expect(result).toEqual({
      ok: false,
      reason: 'no routeParams entry for /orgs/:org/invoices/:id (params: :org, :id)',
    });
  });

  it('allows an override on a static route', () => {
    expect(concretePath('/about', { '/about': '/about?x=1' })).toEqual({ ok: true, path: '/about?x=1' });
  });
});

describe('joinUrl', () => {
  it('normalises slashes', () => {
    expect(joinUrl('http://a.test/', '/x')).toBe('http://a.test/x');
    expect(joinUrl('http://a.test', 'x')).toBe('http://a.test/x');
  });
});
