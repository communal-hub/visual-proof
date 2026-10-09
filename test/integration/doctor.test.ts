import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDoctor, type DoctorReport } from '../../src/doctor.js';
import { normalizeDoctorReport } from '../../src/normalize.js';
import { REPO_ROOT, createHarness, type Harness } from './harness.js';

const GOLDEN = path.join(REPO_ROOT, 'test/golden/doctor-fixture.json');

let h: Harness;
let green: DoctorReport;
let greenMs: number;
let greenOnDisk: unknown;
beforeAll(async () => {
  // replay.enabled false keeps the golden file independent of whether this machine has ffmpeg (the replay row has its own unit tests).
  h = await createHarness({ config: { replay: { enabled: false } } });
  // Computed here (not in an `it`) so every test below stands alone, in any order or on its own.
  const t0 = Date.now();
  green = await runDoctor(h.config, { dirs: h.dirs });
  greenMs = Date.now() - t0;
  greenOnDisk = JSON.parse(fs.readFileSync(path.join(h.dirs.statusDir, 'doctor.json'), 'utf8'));
});
afterAll(async () => {
  await h?.cleanup();
});

const normalize = (report: DoctorReport) => normalizeDoctorReport(report, { roots: [{ path: h.dir, label: '<repo>' }] });

describe('doctor against the vite-vue fixture', () => {
  it('all green with the dev server up: browser launches, barrier is vite-hmr, login works', () => {
    expect(greenMs).toBeLessThan(10_000);

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
      paramTiers: { tier: 'none', status: 'ok', detail: '1 route(s) with params: config 1, seed-file 0, list-endpoint 0, uncovered 0' },
    });
    expect(greenOnDisk).toEqual(green);
  });

  it('matches the checked-in golden file', () => {
    const actual = `${JSON.stringify(normalize(green), null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, actual);
    expect(actual).toBe(fs.readFileSync(GOLDEN, 'utf8'));
  });

  it('doctor --json --normalize prints the checked-in golden byte for byte, whatever the port, temp dir and timings', async () => {
    const cli = await h.cli('doctor', '--json', '--normalize');
    expect(cli.code).toBe(0);
    expect(cli.stdout).toBe(fs.readFileSync(GOLDEN, 'utf8'));
    expect(cli.stdout).not.toContain(String(h.port));
    expect(cli.stdout).not.toContain(h.dir);
  });

  it('the CLI prints a table and exits 0', async () => {
    const cli = await h.cli('doctor');
    expect(cli.code).toBe(0);
    expect(cli.stderr).toBe('');
    const lines = cli.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(16);
    expect(lines.at(-1)).toBe(`details: ${path.join(h.dirs.statusDir, 'doctor.json')}`);
    expect(cli.stdout).toMatch(/^barrier\s+vite-hmr\s+ok\s/m);
    expect(cli.stdout).toMatch(/^login\s+http-hook\s+ok\s/m);
  });

  it('--json prints the report itself, which is also what doctor.json holds', async () => {
    const cli = await h.cli('doctor', '--json');
    expect(cli.code).toBe(0);
    const printed = JSON.parse(cli.stdout) as DoctorReport;
    expect(printed.ok).toBe(true);
    expect(Object.keys(printed.capabilities)).toEqual(Object.keys(green.capabilities));
    expect(printed).toEqual(JSON.parse(fs.readFileSync(path.join(h.dirs.statusDir, 'doctor.json'), 'utf8')));
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
