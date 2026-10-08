import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFinish } from '../../src/finish.js';
import { createHarness, type Harness } from '../integration/harness.js';
import { DATA, forRoute, readBlock } from './helpers.js';

const CHILD = 'src/components/FlaggedDetails.vue';
const FLAGGED_ROUTE = '/flagged';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await h.start();
});
afterEach(async () => {
  await h?.cleanup();
});

const editChild = (text: string) => h.edit(CHILD, (s) => s.replace(/<h2>[^<]*<\/h2>/, `<h2>${text}</h2>`));
const setFlag = (on: boolean) => h.edit(DATA, (s) => s.replace(/"showDetails":\s*(true|false)/, `"showDetails": ${on}`));

describe('never-rendered', () => {
  it('a clean still that never shows the changed component fails finish', async () => {
    // The flag is off, so Flagged.vue renders its "switched off" branch and never mounts the child.
    editChild('Flagged details (never shown)');
    const event = await h.waitForFrame(forRoute(FLAGGED_ROUTE), 10_000);
    expect(event.frame.status).toBe('clean'); // the route loads fine: nothing else is wrong with the frame
    expect(event.frame.renderedFiles).toContain('src/pages/Flagged.vue');
    expect(event.frame.renderedFiles).not.toContain(CHILD);
    expect(event.signals.text).toContain('Details are switched off');
    h.commitAll('edit a component behind a v-if');

    const result = await h.finish();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      `${CHILD} never rendered on ${FLAGGED_ROUTE}; seed the state that shows it (RecordsVisualProofRoutes) or add it to ignoreScreenGlobs`,
    ]);
    expect(readBlock(result)).toContain('never rendered on /flagged');

    const cli = await h.cli('finish');
    expect(cli.code).toBe(1);
    expect(cli.stderr).toContain(`${CHILD} never rendered on ${FLAGGED_ROUTE}`);
  });

  it('passes once the seeded state shows the component', async () => {
    setFlag(true);
    editChild('Flagged details (shown)');
    const event = await h.waitForFrame(forRoute(FLAGGED_ROUTE, (e) => e.signals.text.includes('Flagged details (shown)')), 10_000);
    expect(event.frame.renderedFiles).toEqual(expect.arrayContaining([CHILD, 'src/pages/Flagged.vue', 'src/App.vue']));
    h.commitAll('edit a component that is shown');

    const result = await h.finish();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('renderCheck "warn" keeps the same finding as a note, and "off" drops it', async () => {
    editChild('Flagged details (warn)');
    await h.waitForFrame(forRoute(FLAGGED_ROUTE), 10_000);
    h.commitAll('edit a component behind a v-if');

    const warned = await runFinish({ ...h.config, renderCheck: 'warn' }, { env: h.env });
    expect(warned.failures).toEqual([]);
    expect(warned.notes.some((n) => n.startsWith(`${CHILD} never rendered on ${FLAGGED_ROUTE}`))).toBe(true);

    const off = await runFinish({ ...h.config, renderCheck: 'off' }, { env: h.env });
    expect(off.failures).toEqual([]);
    expect(off.notes.some((n) => n.includes('never rendered'))).toBe(false);
  });
});
