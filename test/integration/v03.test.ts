import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Browser } from '../../src/browser.js';
import { forRoute, HOME, REPORTS, setHeading, sleep } from '../corpus/helpers.js';
import { createHarness, harnessFiles, type Harness } from './harness.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.cli('stop');
  await h?.cleanup();
  h = null;
});

const readStatus = (harness: Harness): Record<string, any> | null => {
  try {
    return JSON.parse(fs.readFileSync(harnessFiles(harness).status, 'utf8'));
  } catch {
    return null;
  }
};

describe('warm-up', () => {
  it('visits the first route before the watcher reports ready; status stays starting meanwhile', async () => {
    h = await createHarness({ freshViteCache: true });
    const logs: string[] = [];
    const browser = await Browser.launch(h.config, { log: (m) => logs.push(m) });
    const prime = browser.prime.bind(browser);
    const seen: Array<Record<string, any> | null> = [];
    browser.prime = async (url) => {
      seen.push(readStatus(h!));
      await sleep(300); // long enough for the poll below to observe it
      return prime(url);
    };

    const started = h.start({ capturer: browser });
    const during: string[] = [];
    while (!(await Promise.race([started.then(() => true), sleep(20).then(() => false)]))) {
      const status = readStatus(h);
      if (status) during.push(`${status.state}/${status.warmup?.state ?? '-'}`);
    }
    expect(during).toContain('starting/running');
    expect(during.every((s) => s === 'starting/running' || s === 'starting/-')).toBe(true);
    expect(seen[0]).toMatchObject({ state: 'starting' });

    const status = readStatus(h)!;
    expect(status).toMatchObject({ state: 'ready', warmup: { state: 'done', routes: [{ route: '/', ok: true }] } });
    expect(status.warmup.ms).toBeGreaterThanOrEqual(300);
    const log = fs.readFileSync(harnessFiles(h).log, 'utf8');
    expect(log).toMatch(/warmup: done in \d+ ms \(\/ \d+ ms\)/);
    expect(log.indexOf('warmup: done in')).toBeLessThan(log.indexOf(' ready (trigger'));
    expect(h.frames).toEqual([]); // warming up takes no stills
  });

  it('first save-to-still after a cold dev-server start: with the warm-up versus without (loose assertion, timings reported)', async () => {
    const run = async (config: Record<string, unknown>) => {
      const harness = await createHarness({ freshViteCache: true, config });
      try {
        const t0 = Date.now();
        await harness.start();
        const startMs = Date.now() - t0;
        const edited = Date.now();
        harness.edit(REPORTS, setHeading('Reports (first save)'));
        await harness.waitForFrame(forRoute('/reports', (e) => e.signals.text.includes('Reports (first save)')), 60_000);
        const log = fs.readFileSync(harnessFiles(harness).log, 'utf8');
        return {
          startMs,
          saveToStillMs: Date.now() - edited,
          reloads: (log.match(/page navigated while settling|Outdated Optimize Dep/g) ?? []).length,
        };
      } finally {
        await harness.cleanup();
      }
    };
    const cold = await run({ warmupRoutes: [] });
    const warm = await run({});
    console.info(`first save-to-still, cold dev server: ${JSON.stringify({ cold, warm })}`);

    // The warm-up moves the cold cost into startup; the first real capture must not be slower for it.
    // (Measured on the fixture: about 1.4 s cold against 0.86 s warm, and the warm-up adds about 1.2 s to startup;
    // the assertion stays loose because the fixture's dependency set is tiny and the suite shares the machine.)
    expect(warm.saveToStillMs).toBeLessThanOrEqual(cold.saveToStillMs);
    expect(warm.startMs).toBeGreaterThan(cold.startMs);
  });
});

describe('status --wait', () => {
  it('blocks until the daemon is ready (happy path), through start, status --wait and the ready alias', async () => {
    h = await createHarness({ freshViteCache: true });
    const started = await h.cli('start');
    expect(started.code).toBe(0);
    const waited = await h.cli('status', '--wait', '--timeout', '120');
    expect(waited.stderr).toBe('');
    expect(waited.code).toBe(0);
    expect(JSON.parse(waited.stdout)).toMatchObject({ state: 'ready', pending: false, warmup: { state: 'done' } });
    const alias = await h.cli('ready', '--timeout', '30');
    expect(alias.code).toBe(0);
    expect(JSON.parse(alias.stdout).state).toBe('ready');
  });

  it('exits 1 with one line, the status path and the log path when the wait times out', async () => {
    h = await createHarness();
    // A watcher that is alive (this very process) but never gets ready.
    fs.mkdirSync(h.dirs.statusDir, { recursive: true });
    fs.writeFileSync(
      harnessFiles(h).status,
      JSON.stringify({ state: 'starting', sessionId: 's-x', pid: process.pid, pending: false, warmup: { state: 'running', routes: [] } }),
    );
    const t0 = Date.now();
    const result = await h.cli('status', '--wait', '--timeout', '1');
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(result.code).toBe(1);
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('not ready after 1 s: starting (warming up Vite)');
    expect(result.stderr).toContain(harnessFiles(h).status);
    expect(result.stderr).toContain(harnessFiles(h).log);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: 'starting' });
  });

  it('fails fast after the daemon was stopped, and when it died without stopping', async () => {
    h = await createHarness();
    expect((await h.cli('start')).code).toBe(0);
    expect((await h.cli('stop')).code).toBe(0);
    const stopped = await h.cli('status', '--wait', '--timeout', '120');
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain('watcher was stopped');

    const status = readStatus(h)!;
    fs.writeFileSync(harnessFiles(h).status, JSON.stringify({ ...status, state: 'ready', pid: 2 ** 22 + 4242 }));
    const dead = await h.cli('status', '--wait', '--timeout', '120');
    expect(dead.code).toBe(1);
    expect(dead.stderr).toContain('watcher is not running');
  });
});

describe('unmapped screen changes', () => {
  it('re-capture the session routes, so their frames stay at HEAD (finish still fails for the unmapped file)', async () => {
    h = await createHarness();
    await h.start();
    h.edit(HOME, setHeading('Home (before orphan)'));
    const first = await h.waitForFrame(forRoute('/', (e) => e.signals.text.includes('before orphan')), 10_000);

    fs.mkdirSync(path.join(h.dir, 'src/orphan'), { recursive: true });
    fs.writeFileSync(path.join(h.dir, 'src/orphan/Unmapped.vue'), '<template><p>not reachable from the router</p></template>\n');
    const again = await h.waitForFrame(forRoute('/', (e) => e.frame.treeHash !== first.frame.treeHash), 10_000);
    expect(again.frame).toMatchObject({ trigger: 'screen', sourceFile: 'src/orphan/Unmapped.vue', status: 'clean' });

    const tree = h.commitAll('home plus an unmapped screen file');
    expect(again.frame.treeHash).toBe(tree);
    const result = await h.finish();
    expect(result.failures).toEqual([
      'no route for src/orphan/Unmapped.vue (not reachable from routeFiles; add staticRoutes or ignoreScreenGlobs)',
    ]);
    expect(result.routes.map((r) => [r.route, r.status])).toEqual([['/', 'clean']]);
  });
});

describe('anchor persistence', () => {
  it('a restarted daemon on the same branch keeps the earliest anchor instead of the new HEAD', async () => {
    h = await createHarness();
    const initial = h.git('rev-parse', 'HEAD');
    await h.start();
    expect(readStatus(h)!.anchor).toBe(initial);
    await h.stopWatch();

    h.edit(HOME, setHeading('Home (committed between sessions)'));
    h.commitAll('work between daemon sessions');
    expect(h.git('rev-parse', 'HEAD')).not.toBe(initial);

    await h.start();
    expect(readStatus(h)!.anchor).toBe(initial);
    expect(fs.readFileSync(harnessFiles(h).log, 'utf8')).toContain(`anchor ${initial.slice(0, 8)} (reused from an earlier session of this branch)`);

    // and finish diffs from it
    const result = await h.finish();
    expect(result.range).toBe('main...HEAD'); // the base ref still wins when it has something to say
    h.git('checkout', '-q', 'main');
    h.git('merge', '-q', '--ff-only', 'work');
    const onMain = await h.finish();
    expect(onMain.range).toBe(`${initial.slice(0, 8)}..HEAD`);
  });
});
