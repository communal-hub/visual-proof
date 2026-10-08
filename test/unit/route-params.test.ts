import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRouteParams } from '../../src/resolve/route-params.js';
import { tmpDir, write } from './helpers.js';

let dir: string;
beforeEach(() => {
  dir = tmpDir('vp-params-');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const config = (extra: { routeParams?: Record<string, string>; routeParamsFile?: string } = {}) => ({
  repoDir: dir,
  routeParams: {},
  routeParamsFile: '.visual-proof/params.json',
  ...extra,
});
const seed = (content: unknown): void =>
  write(dir, '.visual-proof/params.json', typeof content === 'string' ? content : JSON.stringify(content));

describe('loadRouteParams', () => {
  it('returns the config routeParams untouched when no file is configured', () => {
    const result = loadRouteParams(config({ routeParams: { '/a/:id': '/a/1' }, routeParamsFile: undefined }));
    expect(result).toEqual({ params: { '/a/:id': '/a/1' }, missing: false, fileEntries: 0, warnings: [] });
  });

  it('reads the { routes: {...} } shape', () => {
    seed({ routes: { '/manage/invoices/:id': '/manage/invoices/42' } });
    const result = loadRouteParams(config());
    expect(result.params).toEqual({ '/manage/invoices/:id': '/manage/invoices/42' });
    expect(result).toMatchObject({ fileEntries: 1, missing: false, warnings: [] });
    expect(result.error).toBeUndefined();
    expect(result.file).toBe(path.join(dir, '.visual-proof/params.json'));
  });

  it('reads the flat shape', () => {
    seed({ '/manage/invoices/:id': '/manage/invoices/42', '/u/:name': '/u/ada' });
    const result = loadRouteParams(config());
    expect(result.params).toEqual({ '/manage/invoices/:id': '/manage/invoices/42', '/u/:name': '/u/ada' });
    expect(result.fileEntries).toBe(2);
  });

  it('lets the file override config for the same key and merges the rest', () => {
    seed({ routes: { '/a/:id': '/a/99', '/c/:id': '/c/3' } });
    const result = loadRouteParams(config({ routeParams: { '/a/:id': '/a/1', '/b/:id': '/b/2' } }));
    expect(result.params).toEqual({ '/a/:id': '/a/99', '/b/:id': '/b/2', '/c/:id': '/c/3' });
    expect(result.fileEntries).toBe(2);
  });

  it('does not mutate the config routeParams', () => {
    seed({ '/a/:id': '/a/99' });
    const routeParams = { '/a/:id': '/a/1' };
    loadRouteParams(config({ routeParams }));
    expect(routeParams).toEqual({ '/a/:id': '/a/1' });
  });

  it('resolves the file against the config dir', () => {
    write(dir, 'sub/seed.json', JSON.stringify({ '/x/:id': '/x/7' }));
    expect(loadRouteParams(config({ routeParamsFile: 'sub/seed.json' })).params).toEqual({ '/x/:id': '/x/7' });
  });

  it('treats a missing file as empty, with no error and no warning', () => {
    const result = loadRouteParams(config({ routeParams: { '/a/:id': '/a/1' } }));
    expect(result).toMatchObject({ params: { '/a/:id': '/a/1' }, missing: true, fileEntries: 0, warnings: [] });
    expect(result.error).toBeUndefined();
  });

  it('reports invalid JSON as an error and keeps the config routeParams', () => {
    seed('{ nope');
    const result = loadRouteParams(config({ routeParams: { '/a/:id': '/a/1' } }));
    expect(result.params).toEqual({ '/a/:id': '/a/1' });
    expect(result.error).toMatch(/^routeParamsFile \.visual-proof\/params\.json is not valid JSON: /);
    expect(result.fileEntries).toBe(0);
  });

  it.each([
    ['an array', '[]'],
    ['a string', '"/a/1"'],
    ['null', 'null'],
    ['routes as an array', '{ "routes": [] }'],
    ['routes as a string', '{ "routes": "/a/1" }'],
  ])('reports a wrong shape (%s) as an error and keeps the config routeParams', (_name, content) => {
    seed(content);
    const result = loadRouteParams(config({ routeParams: { '/a/:id': '/a/1' } }));
    expect(result.params).toEqual({ '/a/:id': '/a/1' });
    expect(result.error).toMatch(/has the wrong shape: /);
  });

  it('ignores and warns on values that are not strings starting with /', () => {
    seed({ routes: { '/ok/:id': '/ok/1', '/num/:id': 5, '/rel/:id': 'rel/1', '/url/:id': 'http://x.test/1', '/null/:id': null } });
    const result = loadRouteParams(config({ routeParams: { '/num/:id': '/num/config' } }));
    expect(result.params).toEqual({ '/ok/:id': '/ok/1', '/num/:id': '/num/config' });
    expect(result.fileEntries).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.warnings).toHaveLength(4);
    expect(result.warnings[0]).toBe('routeParamsFile entry "/num/:id" ignored: value must be a string starting with "/", got 5');
  });

  it('re-reads the file on every call, so a later write is picked up', () => {
    const cfg = config();
    expect(loadRouteParams(cfg).params).toEqual({});
    expect(loadRouteParams(cfg).missing).toBe(true);

    seed({ '/a/:id': '/a/1' });
    expect(loadRouteParams(cfg).params).toEqual({ '/a/:id': '/a/1' });

    seed({ '/a/:id': '/a/2' });
    expect(loadRouteParams(cfg).params).toEqual({ '/a/:id': '/a/2' });

    seed('{ broken');
    expect(loadRouteParams(cfg).error).toBeDefined();

    seed({ routes: { '/a/:id': '/a/3' } });
    const fixed = loadRouteParams(cfg);
    expect(fixed.params).toEqual({ '/a/:id': '/a/3' });
    expect(fixed.error).toBeUndefined();
  });
});
