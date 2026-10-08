import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { DoctorReport } from '../../src/doctor.js';
import { normalizeDoctorReport, normalizeText } from '../../src/normalize.js';

describe('normalizeText', () => {
  it('replaces ports on hosts and IPs, but not other numbers', () => {
    expect(normalizeText('connected at http://localhost:5173 and 127.0.0.1:3000, app.test:8080/x', { system: false })).toBe(
      'connected at http://localhost:<port> and 127.0.0.1:<port>, app.test:<port>/x',
    );
    expect(normalizeText('16 screen file(s), 12:30', { system: false })).toBe('16 screen file(s), 12:30');
  });

  it('replaces hashes, timings and tool versions', () => {
    expect(normalizeText('HEAD tree 1a2b3c4d, commit 0123456789abcdef0123456789abcdef01234567', { system: false })).toBe(
      'HEAD tree <hash>, commit <hash>',
    );
    expect(normalizeText('warmup done in 1234 ms (/ 56 ms)', { system: false })).toBe('warmup done in <n> ms (/ <n> ms)');
    expect(normalizeText('headless Chromium 130.0.6723.58 launched; Playwright 1.64.0', { system: false })).toBe(
      'headless Chromium <version> launched; Playwright <version>',
    );
  });

  it('replaces the given directories, longest first, and the temp and home dirs', () => {
    const text = '/work/app/src/a.vue in /work/app, status /work/status, tmp ' + os.tmpdir() + '/x';
    expect(
      normalizeText(text, {
        roots: [
          { path: '/work', label: '<work>' },
          { path: '/work/app', label: '<repo>' },
          { path: '/work/status', label: '<status-dir>' },
        ],
      }),
    ).toBe('<repo>/src/a.vue in <repo>, status <status-dir>, tmp <tmp>/x');
    expect(normalizeText(`${os.homedir()}/proj`)).toBe('<home>/proj');
  });

  it('leaves route paths alone', () => {
    expect(normalizeText('POST /__playwright__/login -> 204 for /manage/invoices/:id', { system: false })).toBe(
      'POST /__playwright__/login -> 204 for /manage/invoices/:id',
    );
  });
});

describe('normalizeDoctorReport', () => {
  const report: DoctorReport = {
    at: '2026-10-08T12:00:00.000Z',
    ok: true,
    capabilities: {
      browser: { tier: 'chromium', status: 'ok', required: true, detail: 'headless Chromium 131.0.1 launched and closed' },
      barrier: { tier: 'vite-hmr', status: 'ok', required: false, detail: 'HMR websocket connected at http://localhost:49152' },
      git: { tier: 'repo', status: 'ok', required: false, detail: 'HEAD tree abcdef12' },
    } as unknown as DoctorReport['capabilities'],
  };

  it('normalizes every field of the report and the timestamp, and keeps the shape', () => {
    const out = normalizeDoctorReport(report, { system: false });
    expect(out.at).toBe('<timestamp>');
    expect(out.ok).toBe(true);
    expect(Object.keys(out.capabilities)).toEqual(['browser', 'barrier', 'git']);
    expect(out.capabilities.browser.detail).toBe('headless Chromium <version> launched and closed');
    expect(out.capabilities.barrier.detail).toBe('HMR websocket connected at http://localhost:<port>');
    expect(out.capabilities.git.detail).toBe('HEAD tree <hash>');
  });

  it('is stable: two reports that differ only in machine details normalize identically', () => {
    const other = JSON.parse(
      JSON.stringify(report).replace('49152', '60001').replace('abcdef12', '99887766').replace('131.0.1', '140.2.3').replace('2026-10-08', '2027-01-01'),
    ) as DoctorReport;
    expect(normalizeDoctorReport(other, { system: false })).toEqual(normalizeDoctorReport(report, { system: false }));
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(report);
    normalizeDoctorReport(report);
    expect(JSON.stringify(report)).toBe(before);
  });
});
