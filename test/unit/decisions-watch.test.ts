import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaptureResult, Capturer } from '../../src/browser.js';
import { parseConfig, type Config } from '../../src/config.js';
import { readTextSidecar } from '../../src/decisions/sidecar.js';
import type { Dirs } from '../../src/paths.js';
import type { ImportGraph } from '../../src/resolve/import-graph.js';
import { Timeline } from '../../src/timeline.js';
import type { FsWatchOptions, WatchBatch } from '../../src/trigger/fs-watch.js';
import { startWatch, type BatchEvent, type WatchHandle } from '../../src/watch.js';
import { FakeClient, noul, okResult } from './decisions-helpers.js';
import { tmpDir, write } from './helpers.js';

const SHARED = 'src/shared/Badge.vue';
const KEYS = Array.from({ length: 8 }, (_, i) => `/p${i}`);
const graph: ImportGraph = {
  fileToRoutes: new Map([[SHARED, KEYS], ['src/pages/P0.vue', ['/p0']]]),
  routes: KEYS.map((path, i) => ({ path, routeFile: 'src/router.js', component: `src/pages/P${i}.vue`, layouts: [], dynamic: false })),
  unresolved: [],
};

class FakeCapturer implements Capturer {
  urls: string[] = [];
  async warm() {}
  async capture(url: string): Promise<CaptureResult> {
    this.urls.push(url);
    return {
      png: Buffer.from(`png:${url}`),
      pageText: `text of ${url}`,
      finalUrl: url,
      signals: { navOk: true, httpStatus: 200, consoleErrors: [], pageErrors: [], appRootPresent: true, appRootChildCount: 1, visibleSpinnerCount: 0, text: 't' },
    };
  }
  async close() {}
}

let repo: string;
let dirs: Dirs;
let capturer: FakeCapturer;
let handle: WatchHandle | null;
let push: (b: Partial<WatchBatch>) => void;
let batches: BatchEvent[];

const cfg = (decisions: Record<string, unknown> = {}): Config =>
  parseConfig({ appUrl: 'http://app.test', routeFiles: ['src/router/**/*.js'], screenGlobs: ['src/**'], decisions }, repo, {});

beforeEach(() => {
  repo = tmpDir('vp-dwatch-repo-');
  write(repo, SHARED, '<template>badge</template>\n');
  const status = tmpDir('vp-dwatch-status-');
  dirs = { statusDir: status, scratchDir: path.join(status, 'scratch'), artifactDir: path.join(status, 'artifacts') };
  capturer = new FakeCapturer();
  handle = null;
  batches = [];
});
afterEach(async () => {
  await handle?.stop();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(dirs.statusDir, { recursive: true, force: true });
});

async function start(config: Config, extra: Parameters<typeof startWatch>[1] = {}): Promise<void> {
  handle = await startWatch(config, {
    dirs,
    env: {},
    capturer,
    barrier: null,
    barrierTimeoutMs: 1,
    buildGraph: async () => graph,
    treeHash: async () => 'a'.repeat(40),
    startTrigger: async (options: FsWatchOptions) => {
      push = (batch) => options.onBatch({ screen: [], backend: [], startedAt: Date.now(), ...batch });
      return { eventCount: () => 0, stop: async () => {} };
    },
    ...extra,
  });
  handle.events.on('batch', (b: BatchEvent) => batches.push(b));
}

async function nextBatch(count = 1): Promise<void> {
  const deadline = Date.now() + 3000;
  while (batches.length < count) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the batch');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const timeline = () => new Timeline(dirs.scratchDir, 200);

describe('page text sidecar', () => {
  it('is written next to each frame\'s PNG, not into index.jsonl', async () => {
    await start(cfg());
    push({ screen: ['src/pages/P0.vue'] });
    await nextBatch();
    const frame = timeline().list()[0]!;
    expect(readTextSidecar(timeline().pngPath(frame))).toBe('text of http://app.test/p0');
    expect(fs.readFileSync(path.join(dirs.scratchDir, 'index.jsonl'), 'utf8')).not.toContain('text of');
    expect(fs.readdirSync(path.join(dirs.scratchDir, 'frames')).filter((n) => n.endsWith('.text.json'))).toHaveLength(1);
  });

  it.each([[{ verdict: false }], [{ enabled: false }]])('is not written with %j', async (decisions) => {
    await start(cfg(decisions));
    push({ screen: ['src/pages/P0.vue'] });
    await nextBatch();
    expect(readTextSidecar(timeline().pngPath(timeline().list()[0]!))).toBeNull();
  });
});

describe('route pruning in the watcher', () => {
  const client = () =>
    new FakeClient((req) => okResult(Object.fromEntries(Object.keys(req.questions).map((id) => [id, noul(Number(id.slice(1)) < 4 ? 0.9 : 0.05)]))));

  it('captures only the routes the text model keeps for a file that fans out to more than 6, and caches the decision for finish', async () => {
    const fake = client();
    await start(cfg(), { decisionsClient: fake });
    push({ screen: [SHARED] });
    await nextBatch();
    expect(fake.calls).toHaveLength(1);
    expect(capturer.urls).toEqual(['/p0', '/p1', '/p2', '/p3'].map((p) => `http://app.test${p}`));
    expect(timeline().list().map((f) => f.route)).toEqual(['/p0', '/p1', '/p2', '/p3']);
    const cache = JSON.parse(fs.readFileSync(path.join(dirs.statusDir, 'decisions-cache.json'), 'utf8'));
    expect(Object.keys(cache.entries)).toHaveLength(1);
    expect(fs.readFileSync(path.join(dirs.statusDir, 'watcher.log'), 'utf8')).toMatch(/decisions: pruned 4 of 8 route\(s\) for src\/shared\/Badge\.vue/);

    // The same save again is a cache hit: no second request.
    push({ screen: [SHARED] });
    await nextBatch(2);
    expect(fake.calls).toHaveLength(1);
  });

  it('captures every route with no key, with decisions off, or when the request fails', async () => {
    await start(cfg());
    push({ screen: [SHARED] });
    await nextBatch();
    expect(capturer.urls).toHaveLength(8);
    await handle!.stop();

    capturer = new FakeCapturer();
    batches = [];
    const failing = new FakeClient(() => ({ ok: false, kind: 'http', status: 500, error: 'HTTP 500', ms: 1 }));
    await start(cfg(), { decisionsClient: failing });
    push({ screen: [SHARED] });
    await nextBatch();
    expect(failing.calls).toHaveLength(1);
    expect(capturer.urls).toHaveLength(8);
    expect(fs.existsSync(path.join(dirs.statusDir, 'decisions-cache.json'))).toBe(false);
  });
});
