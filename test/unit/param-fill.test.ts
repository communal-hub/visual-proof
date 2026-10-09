import { describe, expect, it } from 'vitest';
import { ParamDiscoverer } from '../../src/resolve/param-discovery.js';
import { ParamFiller, type FillDeps } from '../../src/resolve/param-fill.js';
import { layerParams } from '../../src/resolve/param-tiers.js';
import type { SourceOutcome } from '../../src/resolve/param-sources.js';

const KEY = '/invoices/:id';
const at = '2026-01-01T00:00:00.000Z';

interface Calls {
  source: number;
  collect: number;
}

function filler(opts: {
  config?: Record<string, string>;
  file?: Record<string, string>;
  session?: Record<string, string>;
  source?: SourceOutcome | null;
  links?: string[] | null;
  onDiscovery?: FillDeps['onDiscovery'];
}): { filler: ParamFiller; calls: Calls } {
  const calls: Calls = { source: 0, collect: 0 };
  const seed = {
    params: { ...opts.config, ...opts.file },
    missing: false,
    fileEntries: Object.keys(opts.file ?? {}).length,
    fileKeys: Object.keys(opts.file ?? {}),
    warnings: [],
  };
  const session = {
    rev: 1,
    routes: Object.fromEntries(Object.entries(opts.session ?? {}).map(([k, p]) => [k, { path: p, params: {}, at }])),
    warnings: [],
  };
  const discoverer =
    opts.links === null || opts.links === undefined
      ? null
      : new ParamDiscoverer({
          appUrl: 'http://app.test',
          collect: async () => {
            calls.collect++;
            return { ok: true, hrefs: opts.links!, ms: 1 };
          },
          routes: async () => ['/invoices', KEY],
          fillParent: async () => ({ ok: false, reason: 'unused' }),
        });
  const deps: FillDeps = {
    layered: () => layerParams(seed, session),
    hasSource: () => opts.source !== null && opts.source !== undefined,
    fromSource: async () => {
      calls.source++;
      return opts.source!;
    },
    discoverer,
    onDiscovery: opts.onDiscovery,
  };
  return { filler: new ParamFiller(deps), calls };
}

describe('ParamFiller precedence: session > routeParamsFile > routeParams > paramSources > discovery', () => {
  const everything = {
    config: { [KEY]: '/invoices/config' },
    file: { [KEY]: '/invoices/file' },
    session: { [KEY]: '/invoices/session' },
    source: { ok: true, path: '/invoices/source' } as SourceOutcome,
    links: ['/invoices/discovered'],
  };

  it('takes the session params over everything', async () => {
    const { filler: f, calls } = filler(everything);
    expect(await f.fill(KEY)).toEqual({ ok: true, path: '/invoices/session', from: 'session' });
    expect(calls).toEqual({ source: 0, collect: 0 });
  });

  it('then the seed file', async () => {
    const { filler: f } = filler({ ...everything, session: {} });
    expect(await f.fill(KEY)).toEqual({ ok: true, path: '/invoices/file', from: 'file' });
  });

  it('then config routeParams', async () => {
    const { filler: f } = filler({ ...everything, session: {}, file: {} });
    expect(await f.fill(KEY)).toEqual({ ok: true, path: '/invoices/config', from: 'config' });
  });

  it('then a list endpoint, without loading any page', async () => {
    const { filler: f, calls } = filler({ ...everything, session: {}, file: {}, config: {} });
    expect(await f.fill(KEY)).toEqual({ ok: true, path: '/invoices/source', from: 'source' });
    expect(calls).toEqual({ source: 1, collect: 0 });
  });

  it('then discovery, reporting where the link was', async () => {
    const { filler: f, calls } = filler({ links: ['/invoices/discovered'] });
    expect(await f.fill(KEY)).toMatchObject({ ok: true, path: '/invoices/discovered', from: 'discovered', foundOn: '/invoices' });
    expect(calls.collect).toBe(1);
  });

  it('falls through from a failing source to discovery, and fails with both reasons when neither works', async () => {
    const failing: SourceOutcome = { ok: false, reason: 'paramSources /api/i failed: HTTP 500' };
    expect(await filler({ source: failing, links: ['/invoices/2'] }).filler.fill(KEY)).toMatchObject({ ok: true, from: 'discovered' });
    expect(await filler({ source: failing, links: [] }).filler.fill(KEY)).toEqual({
      ok: false,
      reason: 'paramSources /api/i failed: HTTP 500; discovery: no link matching /invoices/:id on /invoices (the page has no links)',
    });
  });

  it('can fill only when a source or discovery exists', () => {
    expect(filler({}).filler.canFill(KEY)).toBe(false);
    expect(filler({ links: [] }).filler.canFill(KEY)).toBe(true);
    expect(filler({ source: { ok: true, path: '/x' } }).filler.canFill(KEY)).toBe(true);
  });

  it('reports every discovery attempt', async () => {
    const seen: string[] = [];
    const { filler: f } = filler({ links: ['/invoices/2'], onDiscovery: (key, outcome) => seen.push(`${key} ${outcome.ok}`) });
    await f.fill(KEY);
    expect(seen).toEqual([`${KEY} true`]);
  });
});
