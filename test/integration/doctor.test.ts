import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDoctor, type DoctorReport } from '../../src/doctor.js';
import { REPO_ROOT, createHarness, type Harness } from './harness.js';

const GOLDEN = path.join(REPO_ROOT, 'test/golden/doctor-fixture.json');

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.cleanup();
});

/**
 * Strip everything that varies between runs and machines: timestamp, temp paths, ports, hashes,
 * timings, and the Chromium version. What is left is the resolved tiers and details.
 */
function normalize(report: DoctorReport): unknown {
  const tmpRoot = path.dirname(h.dir);
  const text = JSON.stringify({ ...report, at: '<timestamp>' }, null, 2)
    .split(tmpRoot)
    .join('<tmp>')
    .split(`:${h.port}`)
    .join(':<port>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<hash>')
    .replace(/\d+ ms\b/g, '<n> ms')
    .replace(/Chromium \d+(\.\d+)+/g, 'Chromium <version>');
  return JSON.parse(text);
}

describe('doctor against the vite-vue fixture', () => {
  let green: DoctorReport;

  it('all green with the dev server up: browser launches, barrier is vite-hmr, login works', async () => {
    const t0 = Date.now();
    green = await runDoctor(h.config, { dirs: h.dirs });
    expect(Date.now() - t0).toBeLessThan(10_000);

    expect(green.ok).toBe(true);
    expect(green.capabilities).toMatchObject({
      config: { tier: 'valid', status: 'ok' },
      git: { tier: 'repo', status: 'ok' },
      browser: { tier: 'chromium', status: 'ok', required: true },
      trigger: { tier: 'fs-watch', status: 'ok', required: true },
      barrier: { tier: 'vite-hmr', status: 'ok' },
      freshness: { tier: 'marker', status: 'ok' },
      login: { tier: 'http-hook', status: 'ok' },
      routes: { tier: 'import-graph', status: 'ok' },
    });
    expect(JSON.parse(fs.readFileSync(path.join(h.dirs.statusDir, 'doctor.json'), 'utf8'))).toEqual(green);
  });

  it('matches the checked-in golden file', () => {
    const actual = `${JSON.stringify(normalize(green), null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, actual);
    expect(actual).toBe(fs.readFileSync(GOLDEN, 'utf8'));
  });

  it('the CLI prints a table and exits 0', async () => {
    const cli = await h.cli('doctor');
    expect(cli.code).toBe(0);
    expect(cli.stderr).toBe('');
    const lines = cli.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(9);
    expect(cli.stdout).toMatch(/^barrier\s+vite-hmr\s+ok\s/m);
    expect(cli.stdout).toMatch(/^login\s+http-hook\s+ok\s/m);
  });

  it('with the dev server stopped: barrier timeout-only, login failed, still exit 0, under 10 s', async () => {
    await h.stopDevServer();
    const t0 = Date.now();
    const cli = await h.cli('doctor');
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(cli.code).toBe(0);
    expect(cli.stdout).toMatch(/^browser\s+chromium\s+ok\s/m);
    expect(cli.stdout).toMatch(/^barrier\s+timeout-only\s+warn\s/m);
    expect(cli.stdout).toMatch(/^login\s+failed\s+warn\s/m);

    const report = JSON.parse(fs.readFileSync(path.join(h.dirs.statusDir, 'doctor.json'), 'utf8')) as DoctorReport;
    expect(report.ok).toBe(true);
    expect(report.capabilities.barrier).toMatchObject({ tier: 'timeout-only', status: 'warn', required: false });
    expect(report.capabilities.login).toMatchObject({ tier: 'failed', status: 'warn', required: false });
    expect(report.capabilities.login.detail).toContain('ECONNREFUSED');
    // The dev server removes its marker on close.
    expect(report.capabilities.freshness).toMatchObject({ tier: 'marker-missing', status: 'warn' });
    expect(report.capabilities.browser.status).toBe('ok');
    expect(report.capabilities.trigger.status).toBe('ok');
  });
});
