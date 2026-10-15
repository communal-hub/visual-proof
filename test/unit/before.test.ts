import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BEFORE_SCRATCH, mergeBase } from '../../src/before-base.js';
import { runBefore, type DevServer } from '../../src/before.js';
import type { CaptureSignals, Capturer, ScenarioPlan } from '../../src/browser.js';
import { parseConfig, type Config } from '../../src/config.js';
import type { Dirs } from '../../src/paths.js';
import { Timeline } from '../../src/timeline.js';
import { commitAll, git, initRepo, tmpDir, write } from './helpers.js';

const clean: CaptureSignals = { navOk: true, httpStatus: 200, consoleErrors: [], pageErrors: [], appRootPresent: true, appRootChildCount: 1, visibleSpinnerCount: 0, text: 'ok' };

let repo: string;
let dirs: Dirs;
let config: Config;
let captured: string[];
let scenarios: string[];
let servers: number;

const startServer = async (): Promise<DevServer> => {
  servers++;
  return { target: 'http://127.0.0.1:1', stop: async () => {} };
};
const launch = async (): Promise<Capturer> => ({
  warm: async () => {},
  capture: async (url) => {
    captured.push(url);
    return { png: Buffer.from(url), signals: clean, finalUrl: url };
  },
  runScenario: async (plan: ScenarioPlan) => {
    scenarios.push(plan.file);
    return { stills: plan.steps.filter((s) => s.verb === 'still').map((s) => ({ name: (s as { name: string }).name, at: new Date().toISOString(), png: Buffer.from('s'), signals: clean, renderedFiles: null, steps: [], failed: false })), ms: 1 };
  },
  close: async () => {},
});

const claim = (text: string) => fs.writeFileSync(path.join(dirs.statusDir, 'claim.md'), text);
const before = (extra: Parameters<typeof runBefore>[1] = {}) => runBefore(config, { dirs, startServer, launch, claim: true, ...extra });

beforeEach(() => {
  repo = initRepo();
  write(repo, 'src/pages/A.vue', '<template>A</template>\n');
  write(repo, '.visual-proof/sidecars/pick.vp', 'goto /a\nstill open\n');
  commitAll(repo, 'initial');
  git(repo, 'checkout', '-q', '-b', 'work'); // HEAD is the merge-base: nothing committed on the branch yet
  const root = tmpDir('vp-before-');
  dirs = { statusDir: path.join(root, 'status'), scratchDir: path.join(root, 'status/scratch'), artifactDir: path.join(root, 'artifacts') };
  fs.mkdirSync(dirs.statusDir, { recursive: true });
  config = parseConfig({ appUrl: 'http://app.test', routeParams: { '/items/:id': '/items/4' } }, repo, {});
  captured = [];
  scenarios = [];
  servers = 0;
});

describe('before --claim (v0.13)', () => {
  it('captures the claim screens at the merge-base before any edit, with an empty diff', async () => {
    claim('- /a: the picker\n- /items/:id: an item\n- sidecar pick / open: the modal\nNote: words\n');
    const result = await before();
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(captured).toEqual(['http://app.test/a', 'http://app.test/items/4']);
    expect(scenarios).toEqual(['.visual-proof/sidecars/pick.vp']);
    const base = (await mergeBase(repo, 'main'))!;
    const timeline = new Timeline(path.join(dirs.scratchDir, BEFORE_SCRATCH), 200);
    expect(timeline.latestAtTree('/a', base.tree)).toMatchObject({ routeKey: '/a', status: 'clean' });
    expect(timeline.latestAtTree('/items/4', base.tree)).toMatchObject({ routeKey: '/items/:id' });
    expect(timeline.latestAtTree('sidecar:.visual-proof/sidecars/pick.vp#open', base.tree)).toBeDefined();
    expect(result.notes).toContain('claim line "Note" names no route or sidecar still; not captured');
  });

  it('does not start a server again for screens that already have a before frame at the merge-base', async () => {
    claim('- /a: the picker\n');
    await before();
    expect(servers).toBe(1);
    const again = await before();
    expect(servers).toBe(1);
    expect(again).toMatchObject({ ok: true, captures: [expect.objectContaining({ label: '/a', already: true, status: 'clean' })] });
    expect(again.notes.at(-1)).toMatch(/every screen already has a before frame at merge-base/);
  });

  it('skips an uncommitted sidecar and says so, unless asked for the working tree', async () => {
    write(repo, '.visual-proof/sidecars/new.vp', 'goto /a\nstill fresh\n');
    claim('- sidecar new / fresh: x\n');
    const committed = await before();
    expect(scenarios).toEqual([]);
    expect(committed.notes).toContain('sidecar .visual-proof/sidecars/new.vp is not committed; skipped (commit it, or use --working-tree-sidecars)');
    await before({ workingTreeSidecars: true });
    expect(scenarios).toEqual(['.visual-proof/sidecars/new.vp']);
  });

  it('says so when there is no claim, and when it names no screens', async () => {
    expect((await before()).error).toMatch(/^no claim at .*claim\.md/);
    claim('Note: nothing here\n');
    expect(await before()).toMatchObject({ ok: true, captures: [] });
    expect(servers).toBe(0);
  });
});

describe('before without --claim (v0.13)', () => {
  it('says that an empty diff has nothing to compare and how to capture the claim screens anyway', async () => {
    const result = await runBefore(config, { dirs, startServer, launch });
    expect(result.notes).toEqual(['no screen changes: nothing to compare (before --claim captures the claim screens whatever the diff)']);
    expect(servers).toBe(0);
  });
});
