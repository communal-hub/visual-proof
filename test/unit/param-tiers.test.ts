import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Status } from '../../src/status.js';
import { explainUnfilled, layerParams, loadLayeredParams, seedCandidates, setCommand, unfilledMessage, CREATE_RECORD_ADVICE } from '../../src/resolve/param-tiers.js';
import { loadRouteParams } from '../../src/resolve/route-params.js';
import { setSessionParams } from '../../src/resolve/session-params.js';
import { tmpDir, write } from './helpers.js';

let repo: string;
let sessionFile: string;
beforeEach(() => {
  repo = tmpDir('vp-tiers-');
  sessionFile = path.join(tmpDir('vp-tiers-status-'), 'session-params.json');
});

const at = '2026-01-01T00:00:00.000Z';

describe('layered route params: precedence', () => {
  it('session > routeParamsFile > routeParams, each key from the highest tier that has it', () => {
    write(repo, 'seed.json', JSON.stringify({ '/b/:id': '/b/file', '/c/:id': '/c/file', '/d/:id': '/d/file' }));
    setSessionParams(sessionFile, '/c/:id', { path: '/c/session', params: { id: 'session' }, at });
    setSessionParams(sessionFile, '/d/:id', { path: '/d/session', params: { id: 'session' }, at });
    const layered = loadLayeredParams(
      { repoDir: repo, routeParams: { '/a/:id': '/a/config', '/b/:id': '/b/config', '/d/:id': '/d/config' }, routeParamsFile: 'seed.json' },
      sessionFile,
    );
    expect(layered.params).toEqual({
      '/a/:id': '/a/config',
      '/b/:id': '/b/file', // the seed file has always overridden routeParams
      '/c/:id': '/c/session',
      '/d/:id': '/d/session',
    });
    expect(layered.origin).toEqual({ '/a/:id': 'config', '/b/:id': 'file', '/c/:id': 'session', '/d/:id': 'session' });
    expect(layered.problems).toEqual([]);
  });

  it('is just routeParams when there is no seed file and no session', () => {
    const layered = loadLayeredParams({ repoDir: repo, routeParams: { '/a/:id': '/a/1' } }, sessionFile);
    expect(layered).toMatchObject({ params: { '/a/:id': '/a/1' }, origin: { '/a/:id': 'config' } });
  });

  it('collects problems from both files and carries on with what is valid', () => {
    write(repo, 'seed.json', '{ nope');
    write(path.dirname(sessionFile), 'session-params.json', '[]');
    const layered = loadLayeredParams({ repoDir: repo, routeParams: { '/a/:id': '/a/1' }, routeParamsFile: 'seed.json' }, sessionFile);
    expect(layered.params).toEqual({ '/a/:id': '/a/1' });
    expect(layered.problems).toHaveLength(2);
    expect(layered.problems[0]).toContain('not valid JSON');
    expect(layered.problems[1]).toContain('session params file has the wrong shape');
  });

  it('layerParams works on already-read tiers', () => {
    const seed = loadRouteParams({ repoDir: repo, routeParams: { '/a/:id': '/a/1' } });
    const layered = layerParams(seed, { rev: 1, routes: { '/a/:id': { path: '/a/2', params: { id: '2' }, at } }, warnings: [] });
    expect(layered.params['/a/:id']).toBe('/a/2');
  });
});

describe('the params set command', () => {
  it('quotes the route key and lists every param', () => {
    expect(setCommand('/invoices/:id', ['id'])).toBe("npx visual-proof params set '/invoices/:id' id=<value>");
    expect(setCommand('/clubs/:clubId/teams/:teamId', ['clubId', 'teamId'])).toBe("npx visual-proof params set '/clubs/:clubId/teams/:teamId' clubId=<value> teamId=<value>");
    expect(setCommand('/u/:id(\\d+)', ['id'])).toBe("npx visual-proof params set '/u/:id(\\d+)' id=<value>");
    expect(setCommand("/o'neil/:id", ['id'])).toBe("npx visual-proof params set '/o'\\''neil/:id' id=<value>");
  });
});

describe('explainUnfilled / unfilledMessage', () => {
  const base = {
    routeKey: '/invoices/:id',
    config: { routeParams: {}, routeParamsFile: undefined, paramSources: {}, paramDiscovery: 'links' as const },
    layered: { seed: { params: {}, missing: false, fileEntries: 0, fileKeys: [], warnings: [] }, session: { rev: 0, routes: {}, warnings: [] } },
    status: null as Partial<Status> | null,
    watcherLive: true,
  };

  it('names the command, the advice and what each tier did', () => {
    const status: Partial<Status> = { paramDiscovery: { '/invoices/:id': { error: 'no link matching /invoices/:id on /invoices', at } } };
    const u = explainUnfilled({ ...base, status });
    expect(u).toMatchObject({ routeKey: '/invoices/:id', params: ['id'], command: "npx visual-proof params set '/invoices/:id' id=<value>", advice: CREATE_RECORD_ADVICE });
    expect(u.tiers).toEqual([
      { tier: 'session', tried: true, reason: 'none set' },
      { tier: 'routeParams', tried: true, reason: 'no entry' },
      { tier: 'routeParamsFile', tried: false, reason: 'not configured' },
      { tier: 'paramSources', tried: false, reason: 'not configured' },
      { tier: 'discovery', tried: true, reason: 'no link matching /invoices/:id on /invoices' },
    ]);
    expect(unfilledMessage(u)).toBe(
      "cannot capture /invoices/:id: params unfilled. Tried: session: none set; routeParams: no entry; routeParamsFile: not configured; paramSources: not configured; discovery: no link matching /invoices/:id on /invoices. Fix: npx visual-proof params set '/invoices/:id' id=<value>. If no record exists, create one first (e.g. with the app's factories or seeders) and use its id.",
    );
  });

  it('explains a seed file that is missing or broken, a failed source, and a switched-off discovery', () => {
    const u = explainUnfilled({
      ...base,
      config: { routeParams: {}, routeParamsFile: '.vp/params.json', paramSources: { '/invoices/:id': { url: '/api/i', pick: '0.id' } }, paramDiscovery: 'off' },
      layered: { ...base.layered, seed: { ...base.layered.seed, missing: true } },
      status: { paramSources: { '/invoices/:id': { error: 'paramSources /api/i failed: HTTP 500', at } } },
    });
    expect(u.tiers.map((t) => [t.tier, t.tried, t.reason])).toEqual([
      ['session', true, 'none set'],
      ['routeParams', true, 'no entry'],
      ['routeParamsFile', true, 'file not found: .vp/params.json'],
      ['paramSources', true, 'paramSources /api/i failed: HTTP 500'],
      ['discovery', false, 'off (paramDiscovery: "off")'],
    ]);
    // A reason that already starts with its tier name is not prefixed twice.
    expect(unfilledMessage(u)).toContain('Tried: session: none set; routeParams: no entry; routeParamsFile: file not found: .vp/params.json; paramSources /api/i failed: HTTP 500; discovery: off');
  });

  it('says discovery was not attempted, and whether that is because the watcher is not running', () => {
    expect(explainUnfilled({ ...base, watcherLive: false }).tiers.at(-1)).toEqual({ tier: 'discovery', tried: false, reason: 'not attempted (the watcher is not running)' });
    expect(explainUnfilled({ ...base, watcherLive: true }).tiers.at(-1)).toEqual({ tier: 'discovery', tried: false, reason: 'not attempted' });
  });

  it('needs every required param in the command, and none of the optional ones', () => {
    expect(explainUnfilled({ ...base, routeKey: '/clubs/:clubId/teams/:teamId' }).params).toEqual(['clubId', 'teamId']);
    expect(explainUnfilled({ ...base, routeKey: '/clubs/:clubId/teams/:teamId?' }).params).toEqual(['clubId']);
    expect(explainUnfilled({ ...base, routeKey: '/docs/:slug?' }).params).toEqual(['slug']);
  });
});

describe('seedCandidates', () => {
  it('lists session and discovered routes with their param values, once per route key, in key order', () => {
    expect(
      seedCandidates([
        { routeKey: '/teams/:clubId/:teamId', route: '/teams/1/10', paramsFrom: 'discovered', paramsFoundOn: '/teams/1' },
        { routeKey: '/a', route: '/a' },
        { routeKey: '/b/:id', route: '/b/2', paramsFrom: 'config' },
        { routeKey: '/c/:id', route: '/c/3', paramsFrom: 'session' },
        { routeKey: '/c/:id', route: '/c/4', paramsFrom: 'session' },
        { routeKey: '/d/:id', route: '/d/5', paramsFrom: 'source' },
        { routeKey: '/e/:id', route: '/e/6', paramsFrom: 'file' },
      ]),
    ).toEqual([
      { routeKey: '/c/:id', route: '/c/3', params: { id: '3' }, paramsFrom: 'session' },
      { routeKey: '/teams/:clubId/:teamId', route: '/teams/1/10', params: { clubId: '1', teamId: '10' }, paramsFrom: 'discovered', foundOn: '/teams/1' },
    ]);
  });
});
