import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaptureResult, CaptureSignals, Capturer, PrimeResult } from '../../src/browser.js';
import type { JsonResponse } from '../../src/resolve/param-sources.js';
import { parseConfig, type Config } from '../../src/config.js';
import type { Dirs } from '../../src/paths.js';
import type { ImportGraph } from '../../src/resolve/import-graph.js';
import { Timeline } from '../../src/timeline.js';
import type { FsWatchOptions, WatchBatch } from '../../src/trigger/fs-watch.js';
import type { BarrierResult, HmrState } from '../../src/trigger/vite-hmr.js';
import { startWatch, type BarrierSource, type BatchEvent, type WatchHandle } from '../../src/watch.js';
import { tmpDir } from './helpers.js';

const cleanSignals: CaptureSignals = {
  navOk: true,
  httpStatus: 200,
  consoleErrors: [],
  pageErrors: [],
  appRootPresent: true,
  appRootChildCount: 2,
  visibleSpinnerCount: 0,
  text: 'page text',
};

class FakeCapturer implements Capturer {
  urls: string[] = [];
  closed = false;
  warmed = false;
  /** Optional hook run during each capture, after the call is recorded. */
  onCapture: (url: string) => Promise<void> | void = () => {};
  signalsFor: (url: string) => Partial<CaptureSignals> = () => ({});
  failFor: (url: string) => boolean = () => false;
  /** Set to make the fake able to fetch JSON (paramSources); like `prime`, a fake without it cannot. */
  getJson?: (urlPath: string) => Promise<JsonResponse>;
  /** Set to report a timing breakdown on each capture. */
  timing?: { settleMs: number; screenshotMs: number };
  /** Set to make the fake warm-up capable; the default fake cannot prime, like a capturer without the method. */
  prime?: (url: string) => Promise<PrimeResult>;
  async warm() {
    this.warmed = true;
  }
  async capture(url: string): Promise<CaptureResult> {
    this.urls.push(url);
    await this.onCapture(url);
    if (this.failFor(url)) throw new Error(`boom ${url}`);
    return {
      png: Buffer.from(`png:${url}`),
      signals: { ...cleanSignals, ...this.signalsFor(url) },
      finalUrl: url,
      ...(this.timing ? { timing: this.timing } : {}),
    };
  }
  async close() {
    this.closed = true;
  }
}

class FakeBarrier implements BarrierSource {
  state: HmrState = 'connected';
  calls: Array<{ timeoutMs: number; since?: number; files?: string[] }> = [];
  result: BarrierResult = 'hmr';
  started = false;
  stopped = false;
  start() {
    this.started = true;
  }
  async stop() {
    this.stopped = true;
  }
  async waitForNextMessage(timeoutMs: number, options: { since?: number; files?: string[] } = {}) {
    this.calls.push({ timeoutMs, since: options.since, files: options.files });
    return this.result;
  }
  async waitForConnected() {
    return true;
  }
  on() {
    return this;
  }
}

const graph: ImportGraph = {
  fileToRoutes: new Map([
    ['src/pages/Detail.vue', ['/invoices/:id']],
    ['src/pages/Home.vue', ['/']],
    ['src/components/Badge.vue', ['/', '/invoices/:id']],
  ]),
  routes: [],
  unresolved: [],
};

let repo: string;
let dirs: Dirs;
let config: Config;
let capturer: FakeCapturer;
let barrier: FakeBarrier;
let pushBatch: (batch: Partial<WatchBatch>) => void;
let fireEvent: () => void;
let triggerStopped: boolean;
let eventCounter: number;
let handle: WatchHandle | null;
let batches: BatchEvent[];
let tree: string;
let treeCalls: number;

beforeEach(() => {
  repo = tmpDir('vp-watch-repo-');
  const status = tmpDir('vp-watch-status-');
  dirs = { statusDir: status, scratchDir: path.join(status, 'scratch'), artifactDir: path.join(status, 'artifacts') };
  fs.writeFileSync(path.join(repo, '.hot'), 'x');
  config = parseConfig(
    {
      appUrl: 'http://app.test',
      freshnessMarker: '.hot',
      routeFiles: ['src/router/**/*.js'],
      routeParams: { '/invoices/:id': '/invoices/1' },
      screenGlobs: ['src/**'],
      backendGlobs: ['server/**'],
    },
    repo,
    {},
  );
  capturer = new FakeCapturer();
  barrier = new FakeBarrier();
  triggerStopped = false;
  eventCounter = 0;
  handle = null;
  batches = [];
  tree = 'a'.repeat(40);
  treeCalls = 0;
});
afterEach(async () => {
  await handle?.stop();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(dirs.statusDir, { recursive: true, force: true });
});

async function start(overrides: Parameters<typeof startWatch>[1] = {}): Promise<WatchHandle> {
  handle = await startWatch(config, {
    dirs,
    env: {},
    capturer,
    barrier,
    buildGraph: async () => graph,
    treeHash: async () => {
      treeCalls++;
      return tree;
    },
    startTrigger: async (options: FsWatchOptions) => {
      pushBatch = (batch) =>
        options.onBatch({ screen: [], backend: [], startedAt: Date.now(), ...batch });
      fireEvent = () => options.onEvent?.();
      return {
        eventCount: () => eventCounter,
        stop: async () => {
          triggerStopped = true;
        },
      };
    },
    barrierTimeoutMs: 500,
    ...overrides,
  });
  handle.events.on('batch', (b: BatchEvent) => batches.push(b));
  return handle;
}

/** Wait until `count` batches in total have been processed (the event can fire synchronously inside pushBatch). */
async function nextBatch(count = 1): Promise<void> {
  const deadline = Date.now() + 3000;
  while (batches.length < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for batch #${count}; saw ${JSON.stringify(batches)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const timeline = () => new Timeline(dirs.scratchDir, 200);
const logText = () => fs.readFileSync(path.join(dirs.statusDir, 'watcher.log'), 'utf8');
const statusJson = () => JSON.parse(fs.readFileSync(path.join(dirs.statusDir, 'status.json'), 'utf8'));

describe('startWatch', () => {
  it('starts the barrier, warms the browser, and reports ready with the vite-hmr barrier', async () => {
    const h = await start();
    expect(barrier.started).toBe(true);
    expect(capturer.warmed).toBe(true);
    expect(statusJson()).toMatchObject({
      state: 'ready',
      sessionId: h.sessionId,
      trigger: 'fs-watch',
      barrier: 'vite-hmr',
      lastCaptureAt: null,
      lastError: null,
      frames: 0,
    });
  });

  it('records the pid and the HEAD commit it started from (the anchor) in status.json', async () => {
    await start({ headCommit: async () => 'c'.repeat(40) });
    expect(statusJson()).toMatchObject({ pid: process.pid, anchor: 'c'.repeat(40) });
  });

  it('has a null anchor outside a git repo or with no commits', async () => {
    await start({ headCommit: async () => null });
    expect(statusJson().anchor).toBeNull();
  });

  it('reports a timeout-only barrier when the HMR client is disabled', async () => {
    await start({ barrier: null, barrierTimeoutMs: 10 });
    expect(statusJson().barrier).toBe('timeout-only');
  });

  it('fails to start (status error, resources released) when the tree hash cannot be computed', async () => {
    await expect(
      start({
        treeHash: async () => {
          throw new Error('not a git repository');
        },
      }),
    ).rejects.toThrow('not a git repository');
    expect(statusJson()).toMatchObject({ state: 'error', lastError: 'not a git repository' });
    handle = null;
  });
});

describe('status.json shared with finish', () => {
  it("keeps finish's lastFinish across the watcher's own status rewrites", async () => {
    await start();
    const lastFinish = { at: '2026-10-08T12:00:00.000Z', ok: false, failures: ['no frame at HEAD for /'] };
    const file = path.join(dirs.statusDir, 'status.json');
    fs.writeFileSync(file, JSON.stringify({ ...statusJson(), lastFinish }));

    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    const status = statusJson();
    expect(status).toMatchObject({ state: 'ready', frames: 1, lastFinish });

    await handle!.stop();
    expect(statusJson()).toMatchObject({ state: 'stopped', lastFinish });
  });
});

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('pending flag in status.json (what finish waits on)', () => {
  it('is set at the first file event, before the debounce ends, and cleared only when the batch is fully handled', async () => {
    await start();
    expect(statusJson()).toMatchObject({ pending: false, pendingSince: null, lastEventAt: null });

    fireEvent(); // a save: the batch has not even been emitted yet
    expect(statusJson()).toMatchObject({ pending: true, state: 'ready' });
    expect(Date.parse(statusJson().pendingSince)).not.toBeNaN();
    expect(Date.parse(statusJson().lastEventAt)).not.toBeNaN();

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    capturer.onCapture = () => gate;
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await until(() => statusJson().state === 'capturing');
    expect(statusJson().pending).toBe(true);

    release();
    await until(() => statusJson().pending === false);
    expect(statusJson()).toMatchObject({ state: 'ready', pendingSince: null, frames: 1 });
  });

  it('stays pending across a re-queue and clears after the re-capture', async () => {
    await start();
    let captures = 0;
    const pendingDuring: boolean[] = [];
    capturer.onCapture = () => {
      pendingDuring.push(statusJson().pending);
      if (++captures === 1) tree = 'b'.repeat(40);
    };
    fireEvent();
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch(2);
    await until(() => statusJson().pending === false);
    expect(pendingDuring).toEqual([true, true]);
    expect(timeline().list()).toHaveLength(1);
  });

  it('is cleared when the watcher stops', async () => {
    await start();
    fireEvent();
    await handle!.stop();
    expect(statusJson()).toMatchObject({ state: 'stopped', pending: false });
  });
});

describe('lastError as the reason there is no frame', () => {
  it('records a refused capture in lastError and clears it after a clean batch', async () => {
    await start();
    fs.rmSync(path.join(repo, '.hot'));
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    expect(statusJson().lastError).toBe('stale: freshness marker missing, capture refused');

    fs.writeFileSync(path.join(repo, '.hot'), 'x');
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch(2);
    expect(statusJson().lastError).toBeNull();
  });
});

describe('screen batches', () => {
  it('resolves routes, waits on the HMR barrier, and records a frame per route', async () => {
    await start();
    const startedAt = Date.now() - 20;
    pushBatch({ screen: ['src/pages/Detail.vue'], startedAt });
    await nextBatch();

    expect(barrier.calls).toEqual([{ timeoutMs: 500, since: startedAt - 50, files: ['src/pages/Detail.vue'] }]);
    expect(capturer.urls).toEqual(['http://app.test/invoices/1']);
    const frames = timeline().list();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      id: 'f-000001',
      sessionId: handle!.sessionId,
      route: '/invoices/1',
      routeKey: '/invoices/:id',
      treeHash: tree,
      trigger: 'screen',
      sourceFile: 'src/pages/Detail.vue',
      status: 'clean',
      reasons: [],
    });
    expect(fs.readFileSync(timeline().pngPath(frames[0]!), 'utf8')).toBe('png:http://app.test/invoices/1');
    expect(statusJson()).toMatchObject({ state: 'ready', frames: 1, lastCaptureAt: frames[0]!.at });
    expect(logText()).toMatch(/frame f-000001 \/invoices\/1 clean/);
  });

  it('fans a shared component out to every route that renders it', async () => {
    await start();
    pushBatch({ screen: ['src/components/Badge.vue'] });
    await nextBatch();
    expect(capturer.urls.sort()).toEqual(['http://app.test/', 'http://app.test/invoices/1']);
  });

  it('records triage status and reasons from the capture signals', async () => {
    capturer.signalsFor = () => ({ consoleErrors: ['TypeError: x is undefined'] });
    await start();
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    expect(timeline().list()[0]).toMatchObject({
      status: 'error',
      reasons: ['console error: TypeError: x is undefined'],
    });
  });

  it('logs and skips files with no route, and routes whose params are unfilled', async () => {
    config = { ...config, routeParams: {} };
    await start();
    pushBatch({ screen: ['src/pages/Detail.vue', 'src/lib/util.js'] });
    await nextBatch();
    expect(capturer.urls).toEqual([]);
    expect(batches[0]).toMatchObject({ outcome: 'no-routes' });
    expect(logText()).toContain('no route for src/lib/util.js');
    expect(logText()).toContain('skipped route /invoices/:id');
  });

  it('re-reads routeParamsFile for every batch, so a file written after start is picked up', async () => {
    config = { ...config, routeParams: { '/invoices/:id': '/invoices/1' }, routeParamsFile: '.visual-proof/params.json' };
    await start();
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch(1);
    expect(capturer.urls).toEqual(['http://app.test/invoices/1']);

    fs.mkdirSync(path.join(repo, '.visual-proof'));
    fs.writeFileSync(path.join(repo, '.visual-proof/params.json'), JSON.stringify({ routes: { '/invoices/:id': '/invoices/42' } }));
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch(2);
    expect(capturer.urls).toEqual(['http://app.test/invoices/1', 'http://app.test/invoices/42']);
    expect(logText()).not.toContain('warning:');

    // a backend change re-captures the session's routes at their current params
    fs.writeFileSync(path.join(repo, '.visual-proof/params.json'), JSON.stringify({ '/invoices/:id': '/invoices/43' }));
    pushBatch({ backend: ['server/data.json'] });
    await nextBatch(3);
    expect(capturer.urls.at(-1)).toBe('http://app.test/invoices/43');
  });

  it('logs one warning line for an invalid routeParamsFile, falls back to config, and does not repeat it', async () => {
    config = { ...config, routeParamsFile: '.visual-proof/params.json' };
    fs.mkdirSync(path.join(repo, '.visual-proof'));
    fs.writeFileSync(path.join(repo, '.visual-proof/params.json'), '{ nope');
    await start();
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch(1);
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch(2);
    expect(capturer.urls).toEqual(['http://app.test/invoices/1', 'http://app.test/invoices/1']);
    const warnings = logText().split('\n').filter((l) => l.includes('warning: routeParamsFile'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('is not valid JSON');
  });

  it('rebuilds the import graph when a route file or an unknown file changes, not otherwise', async () => {
    let builds = 0;
    await start({
      buildGraph: async () => {
        builds++;
        return graph;
      },
    });
    const afterStart = builds;
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    // Known file: served from the cache, then refreshed once in the background after the batch.
    await new Promise((r) => setTimeout(r, 20));
    expect(builds).toBe(afterStart + 1);

    pushBatch({ screen: ['src/router/index.js'] });
    await nextBatch(2);
    expect(builds).toBe(afterStart + 2);

    pushBatch({ screen: ['src/pages/Brand New.vue'] });
    await nextBatch(3);
    expect(builds).toBe(afterStart + 3);
  });

  it('uses a plain timeout wait when there is no barrier', async () => {
    await start({ barrier: null, barrierTimeoutMs: 80 });
    const t0 = Date.now();
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(75);
    expect(capturer.urls).toEqual(['http://app.test/']);
  });
});

describe('freshness marker', () => {
  it('refuses a capture and records nothing when the marker is missing', async () => {
    await start();
    fs.rmSync(path.join(repo, '.hot'));
    const refused: unknown[] = [];
    handle!.events.on('refused', (e) => refused.push(e));

    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();

    expect(refused).toEqual([
      expect.objectContaining({ reason: 'stale: freshness marker missing, capture refused', screen: ['src/pages/Home.vue'] }),
    ]);
    expect(batches[0]!.outcome).toBe('refused');
    expect(capturer.urls).toEqual([]);
    expect(barrier.calls).toEqual([]);
    expect(timeline().list()).toEqual([]);
    expect(logText()).toContain('stale: freshness marker missing, capture refused');
    expect(statusJson()).toMatchObject({ state: 'ready', frames: 0 });

    fs.writeFileSync(path.join(repo, '.hot'), 'x');
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch(2);
    expect(timeline().list()).toHaveLength(1);
  });

  it('does not check anything when no marker is configured', async () => {
    config = { ...config, freshnessMarker: undefined };
    fs.rmSync(path.join(repo, '.hot'));
    await start();
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    expect(timeline().list()).toHaveLength(1);
  });
});

describe('tree stability', () => {
  it('discards the batch frames when the working tree changed mid-capture, then re-captures', async () => {
    await start();
    const discarded: unknown[] = [];
    handle!.events.on('discarded', (e) => discarded.push(e));
    const frames: unknown[] = [];
    handle!.events.on('frame', (e) => frames.push(e));

    let first = true;
    capturer.onCapture = () => {
      if (first) {
        first = false;
        tree = 'b'.repeat(40); // the user saved again while the page loaded
      }
    };
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch(2);

    expect(discarded).toEqual([
      expect.objectContaining({ routes: ['/'], before: 'a'.repeat(40), after: 'b'.repeat(40), requeued: true }),
    ]);
    expect(batches.map((b) => b.outcome)).toEqual(['discarded', 'captured']);
    // Only the re-capture at the settled tree is on the timeline.
    const recorded = timeline().list();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.treeHash).toBe('b'.repeat(40));
    expect(frames).toHaveLength(1);
    expect(capturer.urls).toHaveLength(2);
    expect(logText()).toMatch(/discarded 1 frame\(s\): working tree changed during capture.*re-queued/);
  });

  it('gives up after maxRequeues when the tree never settles', async () => {
    await start({ maxRequeues: 1 });
    let n = 0;
    capturer.onCapture = () => {
      tree = String(++n).padStart(40, '0');
    };
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(batches.map((b) => b.outcome)).toEqual(['discarded', 'discarded']);
    expect(timeline().list()).toEqual([]);
    expect(logText()).toContain('giving up after repeated changes');
  });

  it('discards and re-captures when a file event arrived during the capture even though the tree hash is unchanged (A -> B -> A)', async () => {
    await start();
    const discarded: Array<{ requeued: boolean; before: string; after: string; events: number }> = [];
    handle!.events.on('discarded', (e) => discarded.push(e));

    let first = true;
    capturer.onCapture = () => {
      if (first) {
        first = false;
        eventCounter++; // saved B and then reverted to A while the page loaded: the hash alone cannot tell
      }
    };
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch(2);

    expect(discarded).toEqual([expect.objectContaining({ requeued: true, before: tree, after: tree, events: 1 })]);
    expect(batches.map((b) => b.outcome)).toEqual(['discarded', 'captured']);
    expect(timeline().list()).toHaveLength(1);
    expect(capturer.urls).toHaveLength(2);
    expect(logText()).toMatch(/discarded 1 frame\(s\): 1 file event\(s\) arrived during capture \(tree unchanged.*re-queued/);
  });

  it('does not discard for events that arrived before the batch started processing', async () => {
    await start();
    eventCounter += 5; // the events that formed this batch were counted when they happened
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    expect(batches[0]!.outcome).toBe('captured');
  });

  it('a requeued batch waits for a fresh HMR message: it does not reuse the old startedAt', async () => {
    await start();
    let first = true;
    capturer.onCapture = () => {
      if (first) {
        first = false;
        tree = 'b'.repeat(40);
      }
    };
    const startedAt = Date.now() - 10_000; // an old save whose message (or the lack of one) is long gone
    pushBatch({ screen: ['src/pages/Home.vue'], startedAt });
    await nextBatch(2);

    expect(barrier.calls).toHaveLength(2);
    expect(barrier.calls[0]!.since).toBe(startedAt - 50);
    expect(barrier.calls[1]!.since).toBeGreaterThan(startedAt + 5_000);
    expect(barrier.calls[1]!.files).toEqual(['src/pages/Home.vue']);
  });

  it('computes the tree hash before and after each capturing batch', async () => {
    await start();
    const base = treeCalls;
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    expect(treeCalls - base).toBe(2);
  });
});

describe('backend batches', () => {
  it('re-captures every distinct route captured this session', async () => {
    await start();
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch(2);
    capturer.urls = [];

    pushBatch({ backend: ['server/data.json'] });
    await nextBatch(3);

    expect(capturer.urls.sort()).toEqual(['http://app.test/', 'http://app.test/invoices/1']);
    const backendFrames = timeline().list().filter((f) => f.trigger === 'backend');
    expect(backendFrames.map((f) => [f.route, f.routeKey, f.sourceFile]).sort()).toEqual([
      ['/', '/', 'server/data.json'],
      ['/invoices/1', '/invoices/:id', 'server/data.json'],
    ]);
    // Backend-only batches skip the HMR barrier.
    expect(barrier.calls).toHaveLength(2);
  });

  it('captures nothing for a backend change before any route was captured', async () => {
    await start();
    pushBatch({ backend: ['server/data.json'] });
    await nextBatch();
    expect(batches[0]!.outcome).toBe('no-routes');
    expect(capturer.urls).toEqual([]);
    expect(logText()).toContain('no routes captured this session yet');
  });

  it('does not count routes whose batch was refused or discarded as captured', async () => {
    await start();
    fs.rmSync(path.join(repo, '.hot'));
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    fs.writeFileSync(path.join(repo, '.hot'), 'x');
    pushBatch({ backend: ['server/data.json'] });
    await nextBatch(2);
    expect(capturer.urls).toEqual([]);
  });

  it('a mixed batch captures the screen routes plus session routes once each, screen trigger winning', async () => {
    await start();
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch(2);
    capturer.urls = [];

    pushBatch({ screen: ['src/pages/Home.vue'], backend: ['server/data.json'] });
    await nextBatch(3);
    expect(capturer.urls.sort()).toEqual(['http://app.test/', 'http://app.test/invoices/1']);
    const last = timeline().list().slice(-2);
    expect(Object.fromEntries(last.map((f) => [f.route, f.trigger]))).toEqual({ '/': 'screen', '/invoices/1': 'backend' });
  });
});

describe('queue', () => {
  it('serialises captures and coalesces batches that arrive while one is in flight', async () => {
    await start();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let concurrent = 0;
    let maxConcurrent = 0;
    let first = true;
    capturer.onCapture = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (first) {
        first = false;
        await gate;
      }
      concurrent--;
    };

    pushBatch({ screen: ['src/pages/Home.vue'] });
    await new Promise((r) => setTimeout(r, 30)); // first capture now blocked on the gate
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    pushBatch({ screen: ['src/components/Badge.vue'] });
    pushBatch({ screen: ['src/pages/Detail.vue', 'src/pages/Home.vue'] });
    release();
    await nextBatch(2);
    await new Promise((r) => setTimeout(r, 50));

    expect(maxConcurrent).toBe(1);
    expect(batches).toHaveLength(2); // the three queued batches became one
    expect(batches[1]!.screen).toEqual(['src/components/Badge.vue', 'src/pages/Detail.vue', 'src/pages/Home.vue']);
    // 1 for the first batch, then each distinct route exactly once.
    expect(capturer.urls.slice(1).sort()).toEqual(['http://app.test/', 'http://app.test/invoices/1']);
    expect(capturer.urls).toHaveLength(3);
  });
});

describe('errors and shutdown', () => {
  it('survives a failing capture: emits error, records lastError, still captures other routes and later batches', async () => {
    capturer.failFor = (url) => url.endsWith('/invoices/1');
    await start();
    const errors: Error[] = [];
    handle!.events.on('error', (e: Error) => errors.push(e));

    pushBatch({ screen: ['src/components/Badge.vue'] });
    await nextBatch();
    expect(errors.map((e) => e.message)).toEqual(['capture /invoices/1 failed: boom http://app.test/invoices/1']);
    expect(timeline().list().map((f) => f.route)).toEqual(['/']);
    expect(statusJson()).toMatchObject({ state: 'ready', lastError: 'capture /invoices/1 failed: boom http://app.test/invoices/1' });

    capturer.failFor = () => false;
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch(2);
    expect(batches[1]!.outcome).toBe('captured');
  });

  it('does not throw when no error listener is attached', async () => {
    capturer.failFor = () => true;
    await start();
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    expect(batches[0]!.outcome).toBe('captured'); // per-route failures do not fail the batch
    expect(logText()).toContain('error: capture / failed');
  });

  it('stop closes the browser, barrier and trigger, writes stopped, and drops queued work', async () => {
    const h = await start();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    capturer.onCapture = () => gate;
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await new Promise((r) => setTimeout(r, 30));
    pushBatch({ screen: ['src/pages/Detail.vue'] }); // queued behind the in-flight capture

    const stopping = h.stop();
    setTimeout(release, 20);
    await stopping;

    expect(capturer.closed).toBe(true);
    expect(barrier.stopped).toBe(true);
    expect(triggerStopped).toBe(true);
    expect(statusJson().state).toBe('stopped');
    expect(timeline().list()).toEqual([]);
    expect(capturer.urls).toEqual(['http://app.test/']);
    await expect(h.stop()).resolves.toBeUndefined();
  });
});

const primed = (reloads = 0): PrimeResult => ({ passes: reloads > 0 ? 2 : 1, reloads, navOk: true, httpStatus: 200 });

describe('warm-up', () => {
  const routeGraph: ImportGraph = {
    fileToRoutes: graph.fileToRoutes,
    routes: ['/invoices/:id', '/orders/:oid', '/', '/about'].map((p) => ({
      path: p,
      routeFile: 'src/router/index.js',
      component: null,
      layouts: [],
      dynamic: false,
    })),
    unresolved: [],
  };
  let primedUrls: string[];
  beforeEach(() => {
    primedUrls = [];
    capturer.prime = async (url) => {
      primedUrls.push(url);
      return primed();
    };
  });

  it('visits the first route of the import graph without unfilled params, before reporting ready', async () => {
    // /invoices/:id has a routeParams entry; /orders/:oid has none, but the first resolvable route wins anyway.
    await start({ buildGraph: async () => routeGraph });
    expect(primedUrls).toEqual(['http://app.test/invoices/1']);
    expect(capturer.urls).toEqual([]); // no screenshots, no frames
    expect(statusJson()).toMatchObject({ state: 'ready', warmup: { state: 'done', routes: [{ route: '/invoices/1', ok: true }] } });
    const log = logText();
    expect(log.indexOf('warmup: done in')).toBeGreaterThan(-1);
    expect(log.indexOf('warmup: done in')).toBeLessThan(log.indexOf(' ready (trigger'));
  });

  it('skips graph routes whose params cannot be filled, and falls back to / without any', async () => {
    config = { ...config, routeParams: {} };
    await start({
      buildGraph: async () => ({ ...routeGraph, routes: routeGraph.routes.filter((r) => r.path !== '/invoices/:id') }),
    });
    expect(primedUrls).toEqual(['http://app.test/']); // /orders/:oid skipped, / is next

    await handle!.stop();
    handle = null;
    primedUrls = [];
    await start({ buildGraph: async () => ({ ...routeGraph, routes: [] }) });
    expect(primedUrls).toEqual(['http://app.test/']);
  });

  it('visits warmupRoutes: route keys through routeParams, concrete paths as they are, unresolvable ones skipped', async () => {
    config = { ...config, warmupRoutes: ['/invoices/:id', '/about', '/orders/:oid', '/about'] };
    await start();
    expect(primedUrls).toEqual(['http://app.test/invoices/1', 'http://app.test/about']);
    expect(logText()).toContain('warmup: skipped /orders/:oid');
  });

  it('an empty warmupRoutes disables the warm-up', async () => {
    config = { ...config, warmupRoutes: [] };
    await start();
    expect(primedUrls).toEqual([]);
    expect(statusJson()).toMatchObject({ state: 'ready', warmup: { state: 'skipped' } });
  });

  it('does not warm up with a capturer that cannot prime', async () => {
    capturer.prime = undefined;
    await start({ buildGraph: async () => routeGraph });
    expect(statusJson()).toMatchObject({ state: 'ready', warmup: { state: 'skipped' } });
  });

  it('stays starting while it warms up, then ready; reloads are reported', async () => {
    let seen: Record<string, unknown> | null = null;
    capturer.prime = async () => {
      seen = statusJson();
      return primed(1);
    };
    await start();
    expect(seen).toMatchObject({ state: 'starting', warmup: { state: 'running' } });
    expect(statusJson()).toMatchObject({ state: 'ready', warmup: { state: 'done', routes: [{ reloads: 1 }] } });
    expect(logText()).toContain('1 reload(s) from Vite, 2 passes');
  });

  it('never fails startup: a throwing prime is logged and the watcher becomes ready', async () => {
    capturer.prime = async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED');
    };
    await start();
    expect(statusJson()).toMatchObject({ state: 'ready', warmup: { state: 'failed', routes: [{ ok: false, error: 'net::ERR_CONNECTION_REFUSED' }] } });
    expect(logText()).toContain('warmup: / failed: net::ERR_CONNECTION_REFUSED');
  });

  it('is bounded by warmupBudgetMs', async () => {
    config = { ...config, warmupBudgetMs: 60, warmupRoutes: ['/', '/about'] };
    capturer.prime = async (url) => {
      primedUrls.push(url);
      await new Promise((r) => setTimeout(r, 2000));
      return primed();
    };
    const t0 = Date.now();
    await start();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(primedUrls).toEqual(['http://app.test/']);
    expect(statusJson()).toMatchObject({ state: 'ready', warmup: { state: 'timeout' } });
  });

  it('queues file events that arrive during the warm-up and captures them once ready', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    capturer.prime = async () => {
      // the trigger is already live: a save during warm-up is held, not captured against a cold server
      pushBatch({ screen: ['src/pages/Home.vue'] });
      await new Promise((r) => setTimeout(r, 30));
      expect(capturer.urls).toEqual([]);
      expect(statusJson()).toMatchObject({ state: 'starting', pending: true });
      await gate;
      return primed();
    };
    setTimeout(release, 50);
    await start();
    await nextBatch();
    expect(capturer.urls).toEqual(['http://app.test/']);
    expect(statusJson()).toMatchObject({ state: 'ready', pending: false, frames: 1 });
  });
});

describe('unmapped screen changes', () => {
  it('re-capture every route captured this session, so frames stay at HEAD', async () => {
    await start();
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch(2);
    capturer.urls = [];

    tree = 'b'.repeat(40);
    pushBatch({ screen: ['src/helpers/orphan.vue'] });
    await nextBatch(3);
    expect(capturer.urls.sort()).toEqual(['http://app.test/', 'http://app.test/invoices/1']);
    const latest = timeline().list().slice(-2);
    expect(latest.map((f) => [f.treeHash, f.trigger, f.sourceFile])).toEqual([
      ['b'.repeat(40), 'screen', 'src/helpers/orphan.vue'],
      ['b'.repeat(40), 'screen', 'src/helpers/orphan.vue'],
    ]);
    expect(logText()).toContain('no route for src/helpers/orphan.vue: re-capturing 2 route(s) captured this session');
  });

  it('capture nothing when no route was captured yet', async () => {
    await start();
    pushBatch({ screen: ['src/helpers/orphan.vue'] });
    await nextBatch();
    expect(batches[0]!.outcome).toBe('no-routes');
    expect(logText()).toContain('no route for src/helpers/orphan.vue: no routes captured this session yet');
  });

  it('a mapped change in the same batch keeps its own trigger and source file', async () => {
    await start();
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch(2);
    capturer.urls = [];
    pushBatch({ screen: ['src/pages/Home.vue', 'src/helpers/orphan.vue'] });
    await nextBatch(3);
    const last = timeline().list().slice(-2);
    expect(Object.fromEntries(last.map((f) => [f.route, [f.trigger, f.sourceFile]]))).toEqual({
      '/': ['screen', 'src/pages/Home.vue'],
      '/invoices/1': ['screen', 'src/helpers/orphan.vue'],
    });
  });
});

describe('frame timing', () => {
  it('stores the capturer timing breakdown on the frame record', async () => {
    capturer.timing = { settleMs: 612, screenshotMs: 48 };
    await start();
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    expect(timeline().list()[0]).toMatchObject({ route: '/', timing: { settleMs: 612, screenshotMs: 48 } });
  });

  it('leaves the field out when the capturer reports none', async () => {
    await start();
    pushBatch({ screen: ['src/pages/Home.vue'] });
    await nextBatch();
    expect(timeline().list()[0]).not.toHaveProperty('timing');
  });
});

describe('paramSources (route params from list endpoints)', () => {
  let json: JsonResponse;
  let fetched: string[];

  beforeEach(() => {
    config = parseConfig(
      {
        appUrl: 'http://app.test',
        freshnessMarker: '.hot',
        routeFiles: ['src/router/**/*.js'],
        screenGlobs: ['src/**'],
        backendGlobs: ['server/**'],
        paramSources: { '/invoices/:id': { url: '/api/invoices', pick: 'data.0.id' } },
      },
      repo,
      {},
    );
    json = { status: 200, json: { data: [{ id: 7 }] } };
    fetched = [];
    capturer.getJson = async (urlPath) => {
      fetched.push(urlPath);
      return json;
    };
  });

  it('fills a param route nobody configured, lazily, and records the outcome in status.json', async () => {
    await start();
    expect(fetched).toEqual([]);
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch();
    expect(fetched).toEqual(['/api/invoices']);
    expect(capturer.urls).toEqual(['http://app.test/invoices/7']);
    expect(timeline().list()[0]).toMatchObject({ route: '/invoices/7', routeKey: '/invoices/:id', status: 'clean' });
    expect(statusJson().paramSources['/invoices/:id']).toMatchObject({ path: '/invoices/7' });
    expect(statusJson().paramSources['/invoices/:id'].error).toBeUndefined();
    expect(logText()).toContain('param source /api/invoices: /invoices/:id -> /invoices/7');
  });

  it('prefers routeParams, then the seed file, over the list endpoint', async () => {
    config = parseConfig(
      {
        appUrl: 'http://app.test',
        freshnessMarker: '.hot',
        routeFiles: ['src/router/**/*.js'],
        screenGlobs: ['src/**'],
        routeParams: { '/invoices/:id': '/invoices/1' },
        paramSources: { '/invoices/:id': { url: '/api/invoices', pick: 'data.0.id' } },
      },
      repo,
      {},
    );
    await start();
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch();
    expect(capturer.urls).toEqual(['http://app.test/invoices/1']);
    expect(fetched).toEqual([]);
  });

  it('caches the lookup for the session', async () => {
    await start();
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch();
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch(2);
    expect(fetched).toEqual(['/api/invoices']);
    expect(capturer.urls).toEqual(['http://app.test/invoices/7', 'http://app.test/invoices/7']);
  });

  it('looks the ids up again on a backend recapture, and captures the new id', async () => {
    await start();
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch();
    json = { status: 200, json: { data: [{ id: 99 }] } }; // a re-seed moved the first row
    capturer.urls = [];
    tree = 'b'.repeat(40);
    pushBatch({ backend: ['server/data.json'] });
    await nextBatch(2);
    expect(fetched).toEqual(['/api/invoices', '/api/invoices']);
    expect(capturer.urls).toEqual(['http://app.test/invoices/99']);
    expect(timeline().list().at(-1)).toMatchObject({ route: '/invoices/99', routeKey: '/invoices/:id', trigger: 'backend' });
  });

  it('skips the route with the source error in the log and in status.json when the endpoint fails', async () => {
    json = { status: 500, error: 'HTTP 500' };
    await start();
    pushBatch({ screen: ['src/pages/Detail.vue', 'src/pages/Home.vue'] });
    await nextBatch();
    expect(capturer.urls).toEqual(['http://app.test/']); // the other route still captures
    expect(timeline().list().map((f) => f.route)).toEqual(['/']);
    expect(statusJson().paramSources['/invoices/:id']).toMatchObject({ error: 'paramSources /api/invoices failed: HTTP 500' });
    expect(logText()).toContain('warning: paramSources /api/invoices failed: HTTP 500 (route /invoices/:id)');
  });

  it('retries after a failure, and clears the error once the source answers', async () => {
    json = { status: 500, error: 'HTTP 500' };
    await start();
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch();
    expect(capturer.urls).toEqual([]);

    json = { status: 200, json: { data: [{ id: 3 }] } };
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch(2);
    expect(capturer.urls).toEqual(['http://app.test/invoices/3']);
    expect(statusJson().paramSources['/invoices/:id']).toMatchObject({ path: '/invoices/3' });
    expect(statusJson().paramSources['/invoices/:id'].error).toBeUndefined();
  });

  it('reports a missing path or a non-scalar value as the reason', async () => {
    json = { status: 200, json: { data: [] } };
    await start();
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch();
    expect(statusJson().paramSources['/invoices/:id'].error).toMatch(/^paramSources \/api\/invoices: data has 0 item\(s\), no index 0/);

    json = { status: 200, json: { data: [{ id: { nested: true } }] } };
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch(2);
    expect(statusJson().paramSources['/invoices/:id'].error).toMatch(/is an object, expected a string or number/);
  });

  it('a capturer that cannot fetch JSON leaves the route skipped with that reason', async () => {
    delete capturer.getJson;
    await start();
    pushBatch({ screen: ['src/pages/Detail.vue'] });
    await nextBatch();
    expect(capturer.urls).toEqual([]);
    expect(statusJson().paramSources['/invoices/:id'].error).toContain('this capturer cannot fetch JSON');
  });

  it('on a backend recapture, skips a source route whose lookup now fails rather than capturing the old id', async () => {
    await start();
    pushBatch({ screen: ['src/pages/Detail.vue', 'src/pages/Home.vue'] });
    await nextBatch();
    json = { status: 503, error: 'HTTP 503' };
    capturer.urls = [];
    pushBatch({ backend: ['server/data.json'] });
    await nextBatch(2);
    expect(capturer.urls).toEqual(['http://app.test/']);
    expect(statusJson().paramSources['/invoices/:id']).toMatchObject({ path: '/invoices/7', error: 'paramSources /api/invoices failed: HTTP 503' });
  });

  it('resolves explicit warmupRoutes entries through the list endpoint', async () => {
    config = parseConfig(
      {
        appUrl: 'http://app.test',
        routeFiles: ['src/router/**/*.js'],
        screenGlobs: ['src/**'],
        warmupRoutes: ['/invoices/:id'],
        paramSources: { '/invoices/:id': { url: '/api/invoices', pick: 'data.0.id' } },
      },
      repo,
      {},
    );
    const primed: string[] = [];
    capturer.prime = async (url) => {
      primed.push(url);
      return { passes: 1, reloads: 0, navOk: true, httpStatus: 200 };
    };
    await start();
    expect(primed).toEqual(['http://app.test/invoices/7']);
  });
});
