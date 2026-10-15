import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Dirs } from '../../src/paths.js';
import { judgeClaimReady, judgeReady, waitForReady } from '../../src/ready.js';
import { tmpDir } from './helpers.js';

let dirs: Dirs;
let out: string;
let err: string;
let clock: number;

const statusFile = () => path.join(dirs.statusDir, 'status.json');
const writeStatus = (status: Record<string, unknown>) => fs.writeFileSync(statusFile(), JSON.stringify(status));
const base = { sessionId: 's-1', pid: process.pid, pending: false, lastError: null };

beforeEach(() => {
  const root = tmpDir('vp-ready-');
  dirs = { statusDir: root, scratchDir: path.join(root, 'scratch'), artifactDir: path.join(root, 'artifacts') };
  out = '';
  err = '';
  clock = 0;
});

/** A fake clock: sleeping advances it, and `onSleep` can change the world meanwhile. */
const run = (timeoutSec: number | undefined, onSleep: (n: number) => void = () => {}) => {
  let sleeps = 0;
  return waitForReady({
    dirs,
    timeoutSec,
    out: (t) => (out += t),
    err: (t) => (err += t),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      onSleep(++sleeps);
    },
  });
};

describe('judgeReady', () => {
  it('is ready only when ready with nothing pending', () => {
    expect(judgeReady({ ...base, state: 'ready' }, false)).toEqual({ ready: true });
    expect(judgeReady({ ...base, state: 'ready', pending: true }, false)).toMatchObject({ ready: false, fatal: false });
    expect(judgeReady({ ...base, state: 'capturing' }, false)).toMatchObject({ ready: false, fatal: false });
  });

  it('says what a starting watcher is doing', () => {
    expect(judgeReady({ ...base, state: 'starting', warmup: { state: 'running' } }, false)).toMatchObject({
      fatal: false,
      reason: 'starting (warming up Vite)',
    });
  });

  it('fails fast on error, a dead watcher and a stopped one', () => {
    expect(judgeReady({ ...base, state: 'error', lastError: 'boom' }, false)).toEqual({ ready: false, fatal: true, reason: 'watcher failed: boom' });
    expect(judgeReady({ ...base, state: 'stopped', stale: true, lastError: 'watcher exited without stopping' }, false)).toMatchObject({
      fatal: true,
      reason: expect.stringContaining('exited without stopping'),
    });
    expect(judgeReady({ ...base, state: 'stopped' }, false)).toMatchObject({ fatal: true, reason: 'watcher was stopped' });
  });

  it('without any status, fails fast unless a start is spawning the watcher', () => {
    expect(judgeReady({ state: 'stopped' }, false)).toMatchObject({ fatal: true, reason: expect.stringContaining('run visual-proof start') });
    expect(judgeReady({ state: 'stopped' }, true)).toMatchObject({ fatal: false });
  });
});

describe('waitForReady', () => {
  it('returns 0 at once for a ready watcher and prints the status with paths', async () => {
    writeStatus({ ...base, state: 'ready' });
    expect(await run(undefined)).toBe(0);
    expect(err).toBe('');
    expect(JSON.parse(out)).toMatchObject({ state: 'ready', paths: { statusDir: dirs.statusDir, log: path.join(dirs.statusDir, 'watcher.log') } });
  });

  it('waits through starting and capturing, then returns 0', async () => {
    writeStatus({ ...base, state: 'starting', warmup: { state: 'running' } });
    const code = await run(60, (n) => {
      if (n === 3) writeStatus({ ...base, state: 'capturing', pending: true });
      if (n === 6) writeStatus({ ...base, state: 'ready' });
    });
    expect(code).toBe(0);
    expect(clock).toBe(6 * 200);
    expect(JSON.parse(out).state).toBe('ready');
  });

  it('times out with one line naming the reason, the status file and the log', async () => {
    writeStatus({ ...base, state: 'starting', warmup: { state: 'running' } });
    expect(await run(2)).toBe(1);
    expect(clock).toBeGreaterThanOrEqual(2000);
    expect(err.trimEnd().split('\n')).toHaveLength(1);
    expect(err).toContain('not ready after 2 s: starting (warming up Vite)');
    expect(err).toContain(statusFile());
    expect(err).toContain(path.join(dirs.statusDir, 'watcher.log'));
    expect(JSON.parse(out).state).toBe('starting');
  });

  it('fails fast on an error state, without waiting', async () => {
    writeStatus({ ...base, state: 'error', lastError: 'browser launch failed' });
    expect(await run(300)).toBe(1);
    expect(clock).toBe(0);
    expect(err).toContain('watcher failed: browser launch failed');
  });

  it('fails fast on a stale status whose watcher process is gone', async () => {
    writeStatus({ ...base, pid: 2 ** 22 + 12345, state: 'ready' }); // no such process
    expect(await run(300)).toBe(1);
    expect(clock).toBe(0);
    expect(err).toContain('watcher is not running');
    expect(JSON.parse(out)).toMatchObject({ state: 'stopped', stale: true });
  });

  it('fails fast when the watcher was stopped, and when there never was one', async () => {
    writeStatus({ ...base, state: 'stopped' });
    expect(await run(300)).toBe(1);
    expect(err).toContain('watcher was stopped');

    err = '';
    fs.rmSync(statusFile());
    expect(await run(300)).toBe(1);
    expect(err).toContain('no watcher is running');
  });

  it('gives a start in progress (pid file, no status yet) a short grace period', async () => {
    fs.writeFileSync(path.join(dirs.statusDir, 'daemon.pid'), `${process.pid}\n`);
    const code = await run(60, (n) => {
      if (n === 4) writeStatus({ ...base, state: 'ready' });
    });
    expect(code).toBe(0);
  });
});

describe('judgeClaimReady (v0.13)', () => {
  const claim = (extra: Record<string, unknown> = {}) => ({
    file: '/s/claim.md',
    tree: 'a'.repeat(40),
    current: true,
    ready: false,
    total: 1,
    captured: 0,
    screens: [{ screen: '/a', kind: 'route', target: '/a', state: 'queued' }],
    request: 5,
    ...extra,
  });
  const live = { ...base, state: 'capturing', pending: true, repoDir: '/repo' };

  it('is ready once every claim screen stands, whatever impact work is left', () => {
    const status = { ...live, remaining: { claim: 0, headline: 0, impact: 31 }, claim: claim({ ready: true, captured: 1, screens: [{ screen: '/a', kind: 'route', state: 'clean' }] }) };
    expect(judgeClaimReady(status, false, 5)).toEqual({ ready: true });
  });

  it('waits until the watcher has answered this request and nothing changed since it looked', () => {
    const ready = claim({ ready: true, captured: 1 });
    expect(judgeClaimReady({ ...live, claim: { ...ready, request: 4 } }, false, 5)).toMatchObject({ ready: false, fatal: false, reason: expect.stringContaining('claim request') });
    expect(judgeClaimReady({ ...live, claim: { ...ready, current: false } }, false, 5)).toMatchObject({ ready: false, fatal: false, reason: expect.stringContaining('files changed') });
    expect(judgeClaimReady({ ...live, claim: claim() }, false, 5)).toEqual({ ready: false, fatal: false, reason: 'claim: 0/1 captured' });
  });

  it('fails fast when the claim names no screens, a claim screen is not clean, or its params are unfilled', () => {
    expect(judgeClaimReady({ ...live, claim: claim({ total: 0, screens: [] }) }, false, 5)).toMatchObject({ fatal: true, reason: expect.stringContaining('the claim names no screens') });
    const notClean = claim({ screens: [{ screen: '/a', kind: 'route', target: '/a', state: 'not-clean', frameId: 'f-3', reason: 'HTTP 500' }] });
    expect(judgeClaimReady({ ...live, claim: notClean }, false, 5)).toEqual({ ready: false, fatal: true, reason: 'claim screen /a: frame f-3 is not clean: HTTP 500' });
    const unfilled = claim({ screens: [{ screen: '/items/:id', kind: 'route', state: 'unfilled', reason: 'no value for :id' }] });
    expect(judgeClaimReady({ ...live, claim: unfilled }, false, 5)).toMatchObject({ fatal: true, reason: expect.stringContaining('params set') });
  });

  it('a missing claim frame is fatal only once the watcher is idle', () => {
    const missing = claim({ screens: [{ screen: '/a', kind: 'route', target: '/a', state: 'missing' }] });
    expect(judgeClaimReady({ ...live, claim: missing }, false, 5)).toMatchObject({ fatal: false });
    expect(judgeClaimReady({ ...live, state: 'ready', pending: false, claim: missing }, false, 5)).toMatchObject({ fatal: true, reason: expect.stringContaining('/a: no frame') });
  });

  it('a stale freshness marker is fatal; an old watcher without claim readiness is fatal; a new one is waited for', () => {
    expect(judgeClaimReady({ ...live, claim: claim({ error: 'stale: freshness marker missing' }) }, false, 5)).toMatchObject({ fatal: true, reason: expect.stringContaining('freshness marker') });
    const { repoDir: _repoDir, ...old } = live;
    expect(judgeClaimReady({ ...old, state: 'ready', pending: false }, false, 5)).toMatchObject({ fatal: true, reason: expect.stringContaining('older than visual-proof 0.13') });
    expect(judgeClaimReady({ ...live, state: 'ready', pending: false }, false, 5)).toMatchObject({ fatal: false });
  });

  it('keeps the fail-fast rules of plain ready', () => {
    expect(judgeClaimReady({ ...base, state: 'error', lastError: 'boom' }, false, 1)).toEqual({ ready: false, fatal: true, reason: 'watcher failed: boom' });
  });
});

describe('waitForReady --claim (v0.13)', () => {
  const runClaim = (timeoutSec: number, onSleep: (n: number) => void = () => {}) => {
    let sleeps = 0;
    return waitForReady({
      dirs,
      timeoutSec,
      claim: true,
      out: (t) => (out += t),
      err: (t) => (err += t),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        onSleep(++sleeps);
      },
    });
  };
  const requestRev = () => JSON.parse(fs.readFileSync(path.join(dirs.statusDir, 'claim-request.json'), 'utf8')).rev as number;
  const claimStatus = (extra: Record<string, unknown>) => ({
    ...base,
    state: 'capturing',
    pending: true,
    repoDir: '/repo',
    remaining: { claim: 0, headline: 0, impact: 31 },
    claim: { file: '/s/claim.md', tree: 't', current: true, ready: false, total: 2, captured: 1, request: 0, screens: [{ screen: '/a', kind: 'route', state: 'clean' }, { screen: '/b', kind: 'route', state: 'queued' }], ...extra },
  });

  it('asks the watcher for the claim screens and returns 0 once it answered with them ready, while impact is still queued', async () => {
    writeStatus(claimStatus({}));
    const code = await runClaim(60, (n) => {
      if (n === 3) writeStatus(claimStatus({ request: requestRev(), ready: true, captured: 2, screens: [{ screen: '/a', kind: 'route', state: 'clean' }, { screen: '/b', kind: 'route', state: 'clean' }] }));
    });
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(JSON.parse(fs.readFileSync(path.join(dirs.statusDir, 'claim-request.json'), 'utf8'))).toMatchObject({ from: 'ready --claim' });
  });

  it('on timeout, says what is still outstanding', async () => {
    writeStatus(claimStatus({ request: Number.MAX_SAFE_INTEGER }));
    expect(await runClaim(2)).toBe(1);
    expect(err).toContain('not ready after 2 s: claim: 1/2 captured (/b queued); impact: 31 queued');
  });
});

describe('waitForReady timeout detail (v0.13)', () => {
  it('names the work left in the batch', async () => {
    writeStatus({ ...base, state: 'capturing', pending: true, remaining: { claim: 0, headline: 1, impact: 31 } });
    expect(await run(1)).toBe(1);
    expect(err).toContain('not ready after 1 s: capturing; headlines: 1 queued; impact: 31 queued');
  });
});
