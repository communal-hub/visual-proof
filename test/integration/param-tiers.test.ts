import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/doctor.js';
import { createHarness, type Harness } from './harness.js';

const CONFIG_FILE = 'visual-proof.param-sources.config.json';
const KEY = '/manage/invoices/:id';

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

describe('doctor with paramSources', () => {
  it('shows what each tier covers and probes the source once with the logged-in session', async () => {
    h = await createHarness({ configFile: CONFIG_FILE });
    const report = await runDoctor(h.config, { dirs: h.dirs });
    expect(report.capabilities.paramTiers).toMatchObject({ tier: 'list-endpoint', status: 'ok', required: false });
    expect(report.capabilities.paramTiers.detail).toBe(
      `4 route(s) with params: session 0, config 0, seed-file 0, list-endpoint 1, discovery 3, uncovered 0; paramDiscovery: links; probe /api/invoices -> /manage/invoices/1`,
    );
    expect(report.capabilities.params).toMatchObject({ tier: 'none' });
    expect(JSON.parse(fs.readFileSync(path.join(h.dirs.statusDir, 'doctor.json'), 'utf8')).capabilities.paramTiers.detail).toContain('list-endpoint 1');
  });

  it('warns when the source answers wrongly, and when the app is down', async () => {
    h = await createHarness({ configFile: CONFIG_FILE, config: { paramSources: { [KEY]: { url: '/api/invoices/99', pick: 'id' } } } });
    const wrong = await runDoctor(h.config, { dirs: h.dirs });
    expect(wrong.capabilities.paramTiers.status).toBe('warn');
    expect(wrong.capabilities.paramTiers.detail).toContain(`probe /api/invoices/99 for ${KEY} failed: HTTP 404`);
    expect(wrong.ok).toBe(true);

    await h.stopDevServer();
    const t0 = Date.now();
    const down = await runDoctor(h.config, { dirs: h.dirs });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(down.capabilities.paramTiers.status).toBe('warn');
    expect(down.capabilities.paramTiers.detail).toContain('paramSources not probed: app not reachable');
  });
});
