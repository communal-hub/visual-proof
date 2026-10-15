import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CaptureSignals, Capturer, ScenarioPlan, ScenarioResult } from '../../src/browser.js';
import { parseConfig, type Config } from '../../src/config.js';
import type { Dirs } from '../../src/paths.js';
import { renderTry, sidecarTryCommand, trySidecar } from '../../src/sidecar-try.js';
import { tmpDir, write } from './helpers.js';

const clean: CaptureSignals = { navOk: true, httpStatus: 200, consoleErrors: [], pageErrors: [], appRootPresent: true, appRootChildCount: 1, visibleSpinnerCount: 0, text: 'ok' };

let repo: string;
let dirs: Dirs;
let config: Config;
let plans: ScenarioPlan[];
let answer: (plan: ScenarioPlan) => ScenarioResult;
let closed: number;

const launch = async (): Promise<Capturer> => ({
  warm: async () => {},
  capture: async () => {
    throw new Error('not used');
  },
  runScenario: async (plan) => {
    plans.push(plan);
    return answer(plan);
  },
  close: async () => {
    closed++;
  },
});

const SC = '.visual-proof/sidecars/refund.vp';

beforeEach(() => {
  repo = tmpDir('vp-try-repo-');
  const status = tmpDir('vp-try-status-');
  dirs = { statusDir: status, scratchDir: path.join(status, 'scratch'), artifactDir: path.join(status, 'artifacts') };
  config = parseConfig({ appUrl: 'http://app.test', routeParams: { '/invoices/:id': '/invoices/7' } }, repo, {});
  write(repo, SC, '# refund flow\ngoto /invoices/:id\nclick [data-test=refund]\nwait [data-test=modal]\nstill modal\n');
  plans = [];
  closed = 0;
  answer = () => ({
    stills: [{ name: 'modal', at: new Date().toISOString(), png: Buffer.from('png'), signals: clean, renderedFiles: null, steps: [], failed: false }],
    ms: 40,
    steps: [
      { line: 2, ms: 20 },
      { line: 3, ms: 10 },
      { line: 4, ms: 5 },
      { line: 5, ms: 5 },
    ],
  });
});

describe('trySidecar', () => {
  it('runs the scenario with its gotos filled, reports every step and writes the stills', async () => {
    const result = await trySidecar(config, SC, { dirs, launch });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.gotos.get(2)).toEqual({ path: '/invoices/7', url: 'http://app.test/invoices/7' });
    expect(plans[0]!.record).toBeUndefined();
    expect(result).toMatchObject({ ok: true, name: 'refund', errors: [] });
    expect(result.steps.map((s) => [s.line, s.status, s.ms])).toEqual([
      [2, 'ok', 20],
      [3, 'ok', 10],
      [4, 'ok', 5],
      [5, 'ok', 5],
    ]);
    expect(result.stills).toEqual([{ name: 'modal', status: 'clean', reasons: [], png: path.join(dirs.scratchDir, 'try', 'refund-modal.png') }]);
    expect(fs.readFileSync(result.stills[0]!.png, 'utf8')).toBe('png');
    expect(closed).toBe(1);
  });

  it('reports a broken selector with its line, the steps after it as skipped, and the error still', async () => {
    answer = () => ({
      stills: [{ name: 'modal', at: new Date().toISOString(), png: Buffer.from('err'), signals: { ...clean, stepFailure: 'line 4: selector not found' } as CaptureSignals, renderedFiles: null, steps: [], failed: true }],
      failure: { line: 4, text: 'wait [data-test=modal]', reason: 'selector not found' },
      ms: 5100,
      steps: [
        { line: 2, ms: 30 },
        { line: 3, ms: 20 },
        { line: 4, ms: 5000 },
      ],
    });
    const result = await trySidecar(config, SC, { dirs, launch });
    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'failed', 'skipped']);
    expect(result.steps[2]).toMatchObject({ line: 4, reason: 'selector not found', ms: 5000 });
    const text = renderTry(result, config.appUrl);
    expect(text).toContain('  FAIL line 4  wait [data-test=modal] (5000 ms): selector not found');
    expect(text).toContain('  skip line 5  still modal');
    expect(text).toMatch(/failed at \.visual-proof\/sidecars\/refund\.vp:4 wait \[data-test=modal\]: selector not found \(2\/4 steps passed, \d+\.\d s\)/);
  });

  it('does not launch a browser for a scenario that does not parse; says where', async () => {
    write(repo, SC, 'goto /a\nclik [data-test=x]\nstill s\n');
    const result = await trySidecar(config, SC, { dirs, launch });
    expect(plans).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, errors: [`${SC}:2: unknown verb "clik" (the verbs are goto, click, fill, press, wait, still, login)`] });
  });

  it('a goto nothing fills fails at that line, with how to fill it', async () => {
    write(repo, SC, 'goto /teams/:teamId\nstill s\n');
    await trySidecar(config, SC, { dirs, launch });
    expect(plans[0]!.gotos.get(1)).toEqual({ error: expect.stringContaining('cannot fill /teams/:teamId') });
  });
});

describe('sidecarTryCommand', () => {
  const run = async (file: string, json = false) => {
    write(repo, 'visual-proof.config.json', JSON.stringify({ appUrl: 'http://app.test', routeParams: { '/invoices/:id': '/invoices/7' } }));
    let out = '';
    let err = '';
    const code = await sidecarTryCommand({
      configPath: path.join(repo, 'visual-proof.config.json'),
      file,
      json,
      env: { VISUAL_PROOF_STATUS_DIR: dirs.statusDir },
      cwd: repo,
      launch,
      out: (t) => (out += t),
      err: (t) => (err += t),
    });
    return { code, out, err };
  };

  it('exits 0 and prints the steps for a passing scenario', async () => {
    const r = await run(SC);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^sidecar \.visual-proof\/sidecars\/refund\.vp \(refund\) against http:\/\/app\.test$/m);
    expect(r.out).toMatch(/^ok: 4 steps, 1 still\(s\) in \d+\.\d s$/m);
  });

  it('exits 1 on a failed step, 3 for a file that does not exist; --json prints the result', async () => {
    answer = () => ({ stills: [], failure: { line: 3, text: 'click [data-test=refund]', reason: 'selector not found' }, ms: 10, steps: [] });
    const r = await run(SC, true);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, failure: { line: 3 } });
    expect((await run('.visual-proof/sidecars/nope.vp')).code).toBe(3);
  });
});
