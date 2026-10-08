import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA, DETAIL, forRoute, setHeading, sleep } from '../corpus/helpers.js';
import { createHarness, harnessFiles, type Harness } from './harness.js';

const CONFIG_FILE = 'visual-proof.param-sources.config.json';
const KEY = '/manage/invoices/:id';

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const readStatus = (harness: Harness): Record<string, any> => JSON.parse(fs.readFileSync(harnessFiles(harness).status, 'utf8'));

describe('paramSources against the fixture (/api/invoices -> /manage/invoices/:id)', () => {
  it('captures a param route nobody configured, and finish proves it', async () => {
    h = await createHarness({ configFile: CONFIG_FILE });
    expect(h.config.routeParams).toEqual({});
    await h.start();

    h.edit(DETAIL, setHeading('From a list endpoint'));
    const event = await h.waitForFrame(forRoute('/manage/invoices/1', (e) => e.signals.text.includes('From a list endpoint')), 15_000);
    expect(event.frame).toMatchObject({ routeKey: KEY, status: 'clean', trigger: 'screen' });
    expect(event.frame.timing).toMatchObject({ settleMs: expect.any(Number), screenshotMs: expect.any(Number) });
    expect(readStatus(h).paramSources[KEY]).toMatchObject({ path: '/manage/invoices/1' });

    h.commitAll('detail heading');
    const result = await h.finish();
    expect(result).toMatchObject({ ok: true, failures: [] });
    expect(result.routes.map((r) => [r.routeKey, r.route, r.status])).toEqual([[KEY, '/manage/invoices/1', 'clean']]);
  });

  it('looks the id up again after a backend change, and finish follows it', async () => {
    h = await createHarness({ configFile: CONFIG_FILE });
    await h.start();
    h.edit(DETAIL, setHeading('Before reseed'));
    await h.waitForFrame(forRoute('/manage/invoices/1', (e) => e.signals.text.includes('Before reseed')), 15_000);
    await sleep(300);

    // A re-seed: invoice 3 now comes first.
    const from = h.frames.length;
    h.edit(DATA, (source) => {
      const data = JSON.parse(source) as { invoices: Array<{ id: number }> };
      data.invoices.reverse();
      return JSON.stringify(data, null, 2);
    });
    const event = await h.waitForFrame(forRoute('/manage/invoices/3'), 15_000, { from });
    expect(event.frame).toMatchObject({ trigger: 'backend', status: 'clean', routeKey: KEY });
    expect(event.signals.text).toContain('INV-003');

    h.commitAll('reseed');
    const result = await h.finish();
    expect(result).toMatchObject({ ok: true, failures: [] });
    expect(result.routes.map((r) => r.route)).toContain('/manage/invoices/3');
  });

  it('a failing source skips the route; finish says "cannot capture" with the source error', async () => {
    h = await createHarness({ configFile: CONFIG_FILE, config: { paramSources: { [KEY]: { url: '/api/invoices/99', pick: 'id' } } } });
    await h.start();
    h.edit(DETAIL, setHeading('Source is broken'));
    await h.waitForEvent('batch', 15_000);
    expect(h.frames).toEqual([]);
    const log = fs.readFileSync(harnessFiles(h).log, 'utf8');
    expect(log).toContain('warning: paramSources /api/invoices/99 failed: HTTP 404 (route /manage/invoices/:id)');
    expect(readStatus(h).paramSources[KEY].error).toBe('paramSources /api/invoices/99 failed: HTTP 404');

    h.commitAll('broken source');
    const result = await h.finish();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([`cannot capture ${KEY}: paramSources /api/invoices/99 failed: HTTP 404 (add routeParams)`]);
    expect(fs.readFileSync(result.proofBlockPath, 'utf8')).toContain('paramSources /api/invoices/99 failed: HTTP 404');
  });

  it('a pick that finds nothing, and a body that is not JSON, are reasons too', async () => {
    h = await createHarness({ configFile: CONFIG_FILE, config: { paramSources: { [KEY]: { url: '/api/invoices', pick: 'data.0.id' } } } });
    await h.start();
    h.edit(DETAIL, setHeading('Wrong pick'));
    await h.waitForEvent('batch', 15_000);
    expect(readStatus(h).paramSources[KEY].error).toMatch(/^paramSources \/api\/invoices: the response is an array but "data" is not an index/);
    await h.stopWatch();

    // A source that answers 200 with something that is not JSON (here a module served by Vite).
    const other = await createHarness({ configFile: CONFIG_FILE, config: { paramSources: { [KEY]: { url: '/src/main.js', pick: '0.id' } } } });
    try {
      await other.start();
      other.edit(DETAIL, setHeading('Not json'));
      await other.waitForEvent('batch', 15_000);
      expect(readStatus(other).paramSources[KEY].error).toBe('paramSources /src/main.js failed: response is not JSON');
    } finally {
      await other.cleanup();
    }
  });
});
