import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Dirs } from '../../src/paths.js';
import { judgeReady, waitForReady } from '../../src/ready.js';
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
