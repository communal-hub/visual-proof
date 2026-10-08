import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaptureResult, CaptureSignals, Capturer } from '../../src/browser.js';
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
  async warm() {
    this.warmed = true;
  }
  async capture(url: string): Promise<CaptureResult> {
    this.urls.push(url);
    await this.onCapture(url);
    if (this.failFor(url)) throw new Error(`boom ${url}`);
    return { png: Buffer.from(`png:${url}`), signals: { ...cleanSignals, ...this.signalsFor(url) }, finalUrl: url };
  }
  async close() {
    this.closed = true;
  }
}

class FakeBarrier implements BarrierSource {
  state: HmrState = 'connected';
  calls: Array<{ timeoutMs: number; since?: number }> = [];
  result: BarrierResult = 'hmr';
  started = false;
  stopped = false;
  start() {
    this.started = true;
  }
  async stop() {
    this.stopped = true;
  }
  async waitForNextMessage(timeoutMs: number, options: { since?: number } = {}) {
    this.calls.push({ timeoutMs, since: options.since });
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
let triggerStopped: boolean;
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
      return {
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

describe('screen batches', () => {
  it('resolves routes, waits on the HMR barrier, and records a frame per route', async () => {
    await start();
    const startedAt = Date.now() - 20;
    pushBatch({ screen: ['src/pages/Detail.vue'], startedAt });
    await nextBatch();

    expect(barrier.calls).toEqual([{ timeoutMs: 500, since: startedAt - 50 }]);
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
