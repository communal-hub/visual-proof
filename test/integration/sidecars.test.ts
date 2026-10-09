import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Browser, type ScenarioPlan } from '../../src/browser.js';
import { parseSidecar, sidecarRoute } from '../../src/sidecar.js';
import type { FrameEvent } from '../../src/watch.js';
import { createHarness, harnessFiles, type Harness } from './harness.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const INTERACT = '/manage/interact';
const MODAL_FILE = 'src/components/ConfirmModal.vue';
const MODAL_SIDECAR = `
# open the refund modal
goto ${INTERACT}
click [data-test=open-modal]
wait [data-test=confirm-modal]
still modal-open
`;

const stillFrame = (file: string, name: string, extra: (e: FrameEvent) => boolean = () => true) => (e: FrameEvent) =>
  e.frame.route === sidecarRoute(file, name) && extra(e);

describe('sidecar scenarios', () => {
  it('captures an open modal as a clean still, with its steps, rendered components and route fields', async () => {
    h = await createHarness();
    await h.start();
    const file = h.writeSidecar('modal', MODAL_SIDECAR); // created after the watcher started
    const event = await h.waitForFrame(stillFrame(file, 'modal-open'), 20_000);

    expect(event.frame).toMatchObject({
      route: `sidecar:${file}#modal-open`,
      routeKey: `sidecar:${file}#modal-open`,
      sourceFile: file,
      trigger: 'sidecar',
      status: 'clean',
      reasons: [],
    });
    expect(event.frame.steps).toEqual([
      { line: 3, text: `goto ${INTERACT}` },
      { line: 4, text: 'click [data-test=open-modal]' },
      { line: 5, text: 'wait [data-test=confirm-modal]' },
      { line: 6, text: 'still modal-open' },
    ]);
    expect(event.signals.text).toContain('Confirm refund');
    expect(event.frame.renderedFiles).toContain(MODAL_FILE);
    expect(event.frame.renderedFiles).toContain('src/pages/Interact.vue');
    expect(fs.readFileSync(event.pngPath).subarray(1, 4).toString()).toBe('PNG');
    expect(h.timeline().list().at(-1)!.steps).toHaveLength(4);
  });

  it('a two-step form: fill, click, press, wait and two stills in one scenario', async () => {
    h = await createHarness();
    await h.start();
    const file = h.writeSidecar(
      'form',
      [
        `goto ${INTERACT}`,
        'fill [data-test=name-input] "Ada Lovelace"',
        'click [data-test=next]',
        'press Tab',
        'wait 200',
        'still step-2',
        'click [data-test=submit]',
        'still done',
      ].join('\n'),
    );
    // Both stills of a scenario arrive in the same batch: look through everything since the start.
    const step2 = await h.waitForFrame(stillFrame(file, 'step-2'), 20_000, { from: 0 });
    const done = await h.waitForFrame(stillFrame(file, 'done'), 20_000, { from: 0 });
    expect(step2.frame.status).toBe('clean');
    expect(step2.signals.text).toContain('Step 2 of 2');
    expect(step2.signals.text).toContain('Review: Ada Lovelace');
    expect(done.frame.status).toBe('clean');
    expect(done.signals.text).toContain('Submitted for Ada Lovelace');
    expect(done.frame.steps!.length).toBeGreaterThan(step2.frame.steps!.length);
  });

  it('login <role> shows the role-gated element, and the default login is back afterwards', async () => {
    h = await createHarness({ config: { roles: { finance: 'finance@example.test' } } });
    await h.start();
    const file = h.writeSidecar(
      'roles',
      [`goto ${INTERACT}`, 'still as-admin', 'login finance', `goto ${INTERACT}`, 'wait [data-test=finance-only]', 'still as-finance'].join('\n'),
    );
    const admin = await h.waitForFrame(stillFrame(file, 'as-admin'), 20_000, { from: 0 });
    const finance = await h.waitForFrame(stillFrame(file, 'as-finance'), 20_000, { from: 0 });
    expect(admin.frame.status).toBe('clean');
    expect(admin.signals.text).toContain('Signed in as admin@example.test');
    expect(admin.signals.text).not.toContain('Finance dashboard');
    expect(finance.frame.status).toBe('clean');
    expect(finance.signals.text).toContain('Signed in as finance@example.test');
    expect(finance.signals.text).toContain('Finance dashboard');

    // The session is the default role's again: an ordinary capture of the same page is the admin's view.
    h.edit('src/pages/Interact.vue', (s) => s.replace('<h1>Interact</h1>', '<h1>Interact (admin view)</h1>'));
    const page = await h.waitForFrame((e) => e.frame.route === INTERACT && e.signals.text.includes('Interact (admin view)'), 20_000);
    expect(page.frame.status).toBe('clean');
    expect(page.signals.text).toContain('Signed in as admin@example.test');
    expect(page.signals.text).not.toContain('Finance dashboard');
  });

  it('replays the scenario when a component it renders is edited, and not for an unrelated file', async () => {
    h = await createHarness();
    await h.start();
    const file = h.writeSidecar('modal', MODAL_SIDECAR);
    await h.waitForFrame(stillFrame(file, 'modal-open'), 20_000);

    const batch = h.waitForEvent<{ routes: string[]; screen: string[] }>('batch', 20_000);
    h.edit('src/pages/Home.vue', (s) => s.replace('Welcome', 'Welcome back'));
    expect((await batch).routes).toEqual(['/']);

    h.edit(MODAL_FILE, (s) => s.replace('Confirm refund', 'Confirm full refund'));
    const replayed = await h.waitForFrame(stillFrame(file, 'modal-open', (e) => e.signals.text.includes('Confirm full refund')), 20_000);
    expect(replayed.frame).toMatchObject({ status: 'clean', trigger: 'screen', sourceFile: file });
    // The page route is captured too: the modal is part of its import graph.
    expect(h.frames.some((f) => f.frame.route === INTERACT)).toBe(true);
  });

  it('replays on a sidecar edit, and on a backend change once it has run this session', async () => {
    h = await createHarness();
    await h.start();
    const file = h.writeSidecar('modal', MODAL_SIDECAR);
    const first = await h.waitForFrame(stillFrame(file, 'modal-open'), 20_000);

    const from = h.frames.length;
    h.edit('server/data.json', (s) => s.replace('"INV-001"', '"INV-001-b"'));
    const again = await h.waitForFrame(stillFrame(file, 'modal-open'), 20_000, { from });
    expect(again.frame.id).not.toBe(first.frame.id);
    expect(again.frame.trigger).toBe('backend');
  });

  it('a sidecar that does not parse is skipped with a log line, and finish names the line', async () => {
    h = await createHarness();
    await h.start();
    const file = h.writeSidecar('typo', `goto ${INTERACT}\nclik [data-test=open-modal]\nstill s\n`);
    const batch = await h.waitForEvent<{ sidecar: string[]; routes: string[] }>('batch', 20_000);
    expect(batch.sidecar).toEqual([file]);
    expect(batch.routes).toEqual([]);
    expect(h.frames).toEqual([]);
    expect(fs.readFileSync(harnessFiles(h).log, 'utf8')).toContain(`warning: sidecar ${file}:2: unknown verb "clik"`);

    h.commitAll('typo');
    const result = await h.finish();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([`sidecar ${file}:2: unknown verb "clik" (the verbs are goto, click, fill, press, wait, still, login)`]);
  });

  it('a step that fails after the last still leaves a failed frame, and finish fails on it', async () => {
    h = await createHarness();
    await h.start();
    const file = h.writeSidecar('tail', `goto ${INTERACT}\nstill ok\nclick [data-test=missing-button]\n`);
    const failed = await h.waitForFrame((e) => e.frame.route === sidecarRoute(file, '!failed'), 30_000);
    expect(failed.frame.status).toBe('error');
    expect(failed.frame.reasons).toEqual(['line 3 click [data-test=missing-button]: selector not found']);
    const ok = h.frames.find((e) => e.frame.route === sidecarRoute(file, 'ok'))!;
    expect(ok.frame.status).toBe('clean');

    h.commitAll('tail');
    const result = await h.finish();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([`sidecar ${file}: final frame is error: line 3 click [data-test=missing-button]: selector not found`]);
  });
});

describe('finish with sidecars', () => {
  it('the render check: a modal behind a click never rendered on its route without a scenario that opens it', async () => {
    h = await createHarness();
    await h.start();
    h.edit(MODAL_FILE, (s) => s.replace('Confirm refund', 'Confirm refund now'));
    await h.waitForFrame((e) => e.frame.route === INTERACT && e.frame.status === 'clean', 20_000);
    h.commitAll('edit the modal');
    const result = await h.finish();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      `${MODAL_FILE} never rendered on ${INTERACT}; seed the state that shows it (RecordsVisualProofRoutes) or add it to ignoreScreenGlobs`,
    ]);
  });

  it('the render check passes when a scenario that visits the route renders the modal; stills are listed after route stills', async () => {
    h = await createHarness();
    await h.start();
    const file = h.writeSidecar('modal', MODAL_SIDECAR);
    await h.waitForFrame(stillFrame(file, 'modal-open'), 20_000);
    // The edit replays both the page route and the scenario (the modal is in the route's import graph).
    h.edit(MODAL_FILE, (s) => s.replace('Confirm refund', 'Confirm refund now'));
    const still = await h.waitForFrame(stillFrame(file, 'modal-open', (e) => e.signals.text.includes('Confirm refund now')), 20_000);
    expect(still.frame.renderedFiles).toContain(MODAL_FILE);
    h.commitAll('edit the modal, with its scenario');

    const result = await h.finish();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    // Route stills first, then sidecar stills, labeled with the scenario and the still.
    expect(result.routes.map((r) => r.via)).toEqual(['screen', 'sidecar']);
    expect(result.notes).toContain(`${MODAL_FILE} rendered in sidecar ${file} still modal-open`);
    const block = fs.readFileSync(result.proofBlockPath, 'utf8');
    const short = result.treeHash!.slice(0, 8);
    const routeAt = block.indexOf(`alt="${INTERACT}"`);
    const sidecarAt = block.indexOf('alt="sidecar modal / modal-open"');
    expect(routeAt).toBeGreaterThan(-1);
    expect(sidecarAt).toBeGreaterThan(routeAt);
    expect(block).toContain(`\`sidecar modal / modal-open\` · clean · tree ${short} · ${file}`);
    const artifact = path.join(h.dirs.artifactDir, `sidecar-modal-modal-open-${short}.png`);
    expect(block).toContain(`<img src="${artifact}"`);
    expect(fs.existsSync(artifact)).toBe(true);
  });

  it('a committed sidecar nobody replayed fails with no frame at HEAD, naming the still', async () => {
    h = await createHarness();
    // No watcher: nothing is captured.
    const file = h.writeSidecar('modal', MODAL_SIDECAR);
    h.commitAll('add the scenario');
    const result = await h.finish();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([`sidecar ${file} still modal-open: no frame at HEAD`]);
    expect(result.hints.join('\n')).toContain('a sidecar scenario has no frame at HEAD');
  });

  it('an untouched sidecar whose goto route changed becomes expected; one for another route does not', async () => {
    h = await createHarness();
    await h.start();
    const mine = h.writeSidecar('modal', MODAL_SIDECAR);
    const other = h.writeSidecar('home', 'goto /\nstill home\n');
    await h.waitForFrame(stillFrame(mine, 'modal-open'), 20_000, { from: 0 });
    await h.waitForFrame(stillFrame(other, 'home'), 20_000, { from: 0 });
    h.commitAll('scenarios'); // base for the next diff
    h.git('branch', '-f', 'main', 'HEAD');
    h.git('checkout', '-q', '-B', 'work2');

    h.edit(MODAL_FILE, (s) => s.replace('Confirm refund', 'Confirm refund (2)'));
    await h.waitForFrame(stillFrame(mine, 'modal-open', (e) => e.signals.text.includes('(2)')), 20_000);
    h.commitAll('edit the modal');
    const result = await h.finish();
    expect(result.failures).toEqual([]);
    expect(result.routes.filter((r) => r.via === 'sidecar').map((r) => r.route)).toEqual([sidecarRoute(mine, 'modal-open')]);
  });
});

describe('Browser.runScenario limits', () => {
  it('never hangs: a scenario that outlives its time limit stops with an error still for the next pending still', async () => {
    h = await createHarness();
    const browser = await Browser.launch(h.config, { scenarioTimeoutMs: 2500, stepTimeoutMs: 2000 });
    try {
      const file = '.visual-proof/sidecars/slow.vp';
      const sidecar = parseSidecar([`goto ${INTERACT}`, 'wait 1500', 'wait 1500', 'wait 1500', 'still never-reached'].join('\n'), file);
      const plan: ScenarioPlan = {
        file,
        name: sidecar.name,
        steps: sidecar.steps,
        gotos: new Map([[1, { url: `${h.appUrl}${INTERACT}`, path: INTERACT }]]),
      };
      const t0 = Date.now();
      const result = await browser.runScenario(plan);
      expect(Date.now() - t0).toBeLessThan(12_000);
      expect(result.failure?.reason).toMatch(/scenario exceeded/);
      expect(result.stills.map((s) => [s.name, s.failed])).toEqual([['never-reached', true]]);
      expect(result.stills[0]!.signals.stepFailure).toMatch(/^line \d+ wait 1500: scenario exceeded/);
    } finally {
      await browser.close();
    }
  });

  it('a goto whose route params cannot be filled is a step failure naming the line', async () => {
    h = await createHarness();
    const browser = await Browser.launch(h.config);
    try {
      const file = '.visual-proof/sidecars/params.vp';
      const sidecar = parseSidecar('goto /manage/orders/:id\nstill s\n', file);
      const result = await browser.runScenario({
        file,
        name: 'params',
        steps: sidecar.steps,
        gotos: new Map([[1, { error: 'cannot fill /manage/orders/:id: no routeParams entry (params: :id)' }]]),
      });
      expect(result.failure).toMatchObject({ line: 1, text: 'goto /manage/orders/:id' });
      expect(result.failure!.reason).toContain('cannot fill /manage/orders/:id');
      expect(result.stills.map((s) => s.name)).toEqual(['s']);
    } finally {
      await browser.close();
    }
  });

  it('a scenario that logged in as another role leaves the default login in place', async () => {
    h = await createHarness({ config: { roles: { finance: 'finance@example.test' } } });
    const browser = await Browser.launch(h.config);
    try {
      const file = '.visual-proof/sidecars/role.vp';
      const sidecar = parseSidecar(`login finance\ngoto ${INTERACT}\nwait [data-test=finance-only]\nstill s\n`, file);
      const gotos = new Map([[2, { url: `${h.appUrl}${INTERACT}`, path: INTERACT }]]);
      const result = await browser.runScenario({ file, name: 'role', steps: sidecar.steps, gotos });
      expect(result.failure).toBeUndefined();
      // After the scenario the shared context is the admin's again.
      const plain = await browser.capture(`${h.appUrl}${INTERACT}`);
      expect(plain.signals.text).toContain('admin@example.test');
    } finally {
      await browser.close();
    }
  });
});

describe('fixture sidecar files', () => {
  it('are found at the default path and committed with the repo (the fixture unignores .visual-proof/sidecars)', async () => {
    h = await createHarness();
    const rel = h.writeSidecar('committed', 'goto /\nstill home\n');
    h.commitAll('add sidecar');
    expect(h.git('ls-tree', '-r', '--name-only', 'HEAD')).toContain(rel);
    expect(path.dirname(rel)).toBe('.visual-proof/sidecars');
  });
});
