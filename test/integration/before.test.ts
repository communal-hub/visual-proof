import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BEFORE_SCRATCH, mergeBase } from '../../src/before-base.js';
import { runBefore, startDevServer } from '../../src/before.js';
import { Browser } from '../../src/browser.js';
import { Timeline } from '../../src/timeline.js';
import { createHarness, type Harness } from './harness.js';

const MARK = 'after-mark-v011';
let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  h.edit('src/pages/Home.vue', (content) => content.replace('</template>', `  <p data-test="mark">${MARK}</p>\n</template>`));
  h.commitAll('home shows the mark');
}, 120_000);
afterAll(async () => {
  await h?.cleanup();
});

describe('the merge-base dev server', () => {
  it('serves the merge-base source from a worktree, and reuses it', async () => {
    const base = (await mergeBase(h.dir, 'main'))!;
    const server = await startDevServer(h.config, base, h.dirs);
    try {
      const atBase = await (await fetch(`${server.target}/src/pages/Home.vue`)).text();
      const atHead = await (await fetch(`${h.appUrl}/src/pages/Home.vue`)).text();
      expect(atHead).toContain(MARK);
      expect(atBase).not.toContain(MARK);
      expect(fs.realpathSync(path.join(h.dirs.scratchDir, BEFORE_SCRATCH, 'worktree/node_modules'))).toBe(fs.realpathSync(path.join(h.dir, 'node_modules')));
    } finally {
      await server.stop();
    }
    const again = await startDevServer(h.config, base, h.dirs);
    await again.stop();
  }, 120_000);

  it('a browser sent to it renders the merge-base frontend against the same login', async () => {
    const base = (await mergeBase(h.dir, 'main'))!;
    const server = await startDevServer(h.config, base, h.dirs);
    const browser = await Browser.launch(h.config, { devServer: { host: new URL(h.config.viteUrl).host, target: server.target } });
    try {
      const shot = await browser.capture(`${h.appUrl}/`);
      expect(shot.signals.navOk).toBe(true);
      expect(shot.signals.consoleErrors).toEqual([]);
      expect(shot.pageText ?? '').not.toContain(MARK);
    } finally {
      await browser.close();
      await server.stop();
    }
    const head = await Browser.launch(h.config);
    try {
      expect((await head.capture(`${h.appUrl}/`)).pageText ?? '').toContain(MARK);
    } finally {
      await head.close();
    }
  }, 120_000);
});

describe('visual-proof before, then finish', () => {
  it('captures the claimed headline at the merge-base and finish pairs it with the HEAD still', async () => {
    fs.writeFileSync(path.join(h.dirs.statusDir, 'claim.md'), '/: the home page shows the mark\n');
    await h.start();
    try {
      h.edit('src/pages/Home.vue', (content) => `${content}\n`);
      h.commitAll('touch home');
      await h.waitForFrame((e) => e.frame.route === '/', 60_000);
    } finally {
      await h.stopWatch();
    }

    const result = await runBefore(h.config, { dirs: h.dirs, env: h.env });
    expect(result.error).toBeUndefined();
    expect(result.captures).toEqual([expect.objectContaining({ label: '/', status: 'clean' })]);
    const base = (await mergeBase(h.dir, 'main'))!;
    expect(new Timeline(path.join(h.dirs.scratchDir, BEFORE_SCRATCH), 200).latestAtTree('/', base.tree)).toBeDefined();

    const finish = await h.finish();
    const home = finish.routes.find((r) => r.route === '/')!;
    expect(home.role).toBe('headline');
    expect(home.before).toMatchObject({ status: 'clean', commit: base.commit });
    expect(finish.proofBlock).toContain('alt="/ (before)"');
  }, 240_000);
});
