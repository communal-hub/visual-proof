import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { changedSessionRoutes, clearSessionParams, readSessionParams, setSessionParams, type SessionEntry } from '../../src/resolve/session-params.js';
import { tmpDir } from './helpers.js';

let file: string;
beforeEach(() => {
  file = path.join(tmpDir('vp-session-'), 'session-params.json');
});

const entry = (p: string, id = '1', at = '2026-01-01T00:00:00.000Z'): SessionEntry => ({ path: p, params: { id }, at });

describe('session params file', () => {
  it('reads as empty when there is no file', () => {
    expect(readSessionParams(file)).toEqual({ rev: 0, routes: {}, warnings: [] });
  });

  it('writes an entry and bumps the revision on every write', () => {
    expect(setSessionParams(file, '/a/:id', entry('/a/1'))).toBe(1);
    expect(setSessionParams(file, '/b/:id', entry('/b/2', '2'))).toBe(2);
    expect(setSessionParams(file, '/a/:id', entry('/a/9', '9'))).toBe(3);
    const read = readSessionParams(file);
    expect(read.rev).toBe(3);
    expect(read.routes).toEqual({ '/a/:id': entry('/a/9', '9'), '/b/:id': entry('/b/2', '2') });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ version: 1, rev: 3 });
  });

  it('clears one route, or all of them, and bumps the revision only when something went', () => {
    setSessionParams(file, '/a/:id', entry('/a/1'));
    setSessionParams(file, '/b/:id', entry('/b/2'));
    expect(clearSessionParams(file, '/a/:id')).toEqual({ cleared: ['/a/:id'], rev: 3 });
    expect(Object.keys(readSessionParams(file).routes)).toEqual(['/b/:id']);
    expect(clearSessionParams(file, '/nope')).toEqual({ cleared: [], rev: 3 });
    expect(clearSessionParams(file)).toEqual({ cleared: ['/b/:id'], rev: 4 });
    expect(readSessionParams(file).routes).toEqual({});
    expect(clearSessionParams(file)).toEqual({ cleared: [], rev: 4 });
  });

  it('clearing with no file writes nothing', () => {
    expect(clearSessionParams(file)).toEqual({ cleared: [], rev: 0 });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('never throws on a broken file: it reads as empty with an error, and a set replaces it', () => {
    fs.writeFileSync(file, '{ nope');
    expect(readSessionParams(file)).toMatchObject({ routes: {}, error: expect.stringContaining('not valid JSON') });
    fs.writeFileSync(file, '[]');
    expect(readSessionParams(file).error).toContain('wrong shape');
    fs.writeFileSync(file, JSON.stringify({ routes: [] }));
    expect(readSessionParams(file).error).toContain('"routes" must be an object');
    setSessionParams(file, '/a/:id', entry('/a/1'));
    const fixed = readSessionParams(file);
    expect(fixed.error).toBeUndefined();
    expect(fixed.routes['/a/:id']).toMatchObject({ path: '/a/1' });
  });

  it('ignores malformed entries with a warning', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, rev: 2, routes: { '/a/:id': { path: '/a/1', params: { id: '1' }, at: 'x' }, '/b/:id': { path: 'b/2' }, '/c/:id': 7 } }),
    );
    const read = readSessionParams(file);
    expect(Object.keys(read.routes)).toEqual(['/a/:id']);
    expect(read.warnings).toHaveLength(2);
    expect(read.warnings[0]).toContain('"/b/:id" ignored');
  });

  it('names the routes whose entry is new or different', () => {
    const before = { '/a/:id': entry('/a/1'), '/b/:id': entry('/b/1') };
    const after = { '/a/:id': entry('/a/1'), '/b/:id': entry('/b/2', '2', '2026-01-02T00:00:00.000Z'), '/c/:id': entry('/c/3') };
    expect(changedSessionRoutes(before, after)).toEqual(['/b/:id', '/c/:id']);
    expect(changedSessionRoutes(after, {})).toEqual([]);
    // Setting the same path again is still a new `set`: it has a new timestamp, so the route is captured again.
    expect(changedSessionRoutes(before, { ...before, '/a/:id': entry('/a/1', '1', '2026-02-01T00:00:00.000Z') })).toEqual(['/a/:id']);
  });
});
