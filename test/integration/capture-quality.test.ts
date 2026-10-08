import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from '../../src/browser.js';
import { createHarness, type Harness } from './harness.js';
import { decodePng, pngSize } from './png.js';

let h: Harness;
let browser: Browser;
const logs: string[] = [];
/** computed visibility of the fake devtools pill, read on the prepared page right before each screenshot */
const pillVisibility: string[] = [];

const MAGENTA = [255, 0, 255];
const GREEN = [0, 255, 0];

beforeAll(async () => {
  h = await createHarness();
  browser = await Browser.launch(h.config, {
    log: (m) => logs.push(m),
    beforeScreenshot: async (page) => {
      pillVisibility.push(
        (await page.evaluate(`getComputedStyle(document.querySelector('.vue-devtools__anchor')).visibility`)) as string,
      );
    },
  });
});
afterAll(async () => {
  await browser?.close();
  await h?.cleanup();
});

const url = (p: string) => `${h.appUrl}${p}`;

describe('full-page capture of an inner scroll container', () => {
  it('captures all of the content of a container that scrolls inside a non-scrolling document', async () => {
    const result = await browser.capture(url('/long'));
    const { width, height } = pngSize(result.png);
    expect(width).toBe(1280);
    expect(height).toBeGreaterThan(h.config.viewport.height);
    expect(height).toBeGreaterThanOrEqual(2600); // 60 rows of 40 px + heading + marker
    expect(result.layout).toMatchObject({ scrollContainer: 'main.content', capped: false, height });
    expect(logs.some((l) => l.includes('expanded scroll container main.content'))).toBe(true);

    // The bottom marker (solid green) is in the last pixels of the still, and the sticky header is not repeated down the page.
    const img = decodePng(result.png);
    expect(img.pixel(640, height - 20)).toEqual(GREEN);
    expect(img.pixel(640, 20)).toEqual([30, 58, 138]); // header colour, once, at the top
    expect(img.pixel(640, Math.floor(height / 2))).not.toEqual([30, 58, 138]);
  });

  it('uses the scrollContainer override and says so when the selector matches nothing', async () => {
    const named = await Browser.launch({ ...h.config, scrollContainer: '[data-test=scroll-content]' });
    try {
      const result = await named.capture(url('/long'));
      expect(pngSize(result.png).height).toBeGreaterThanOrEqual(2600);
      expect(result.layout?.scrollContainer).toBe('main.content');
    } finally {
      await named.close();
    }

    const missing: string[] = [];
    const wrong = await Browser.launch({ ...h.config, scrollContainer: '.does-not-exist' }, { log: (m) => missing.push(m) });
    try {
      const result = await wrong.capture(url('/long'));
      expect(pngSize(result.png).height).toBeLessThan(1000); // the document alone: viewport plus the nav above the shell
      expect(missing.some((l) => l.includes('matched nothing'))).toBe(true);
    } finally {
      await wrong.close();
    }
  });

  it('cuts the still off at maxCaptureHeight', async () => {
    const small = await Browser.launch({ ...h.config, maxCaptureHeight: 1000 });
    try {
      const result = await small.capture(url('/long'));
      expect(pngSize(result.png)).toEqual({ width: 1280, height: 1000 });
      expect(result.layout).toMatchObject({ capped: true, height: 1000 });
      expect(result.layout!.fullHeight).toBeGreaterThan(2600);
    } finally {
      await small.close();
    }
  });

  it('leaves a page that fits the viewport at the viewport size', async () => {
    const result = await browser.capture(url('/'));
    expect(pngSize(result.png)).toEqual({ width: 1280, height: 800 });
    expect(result.layout).toMatchObject({ scrollContainer: null, capped: false });
  });
});

describe('dev overlays', () => {
  it('hides the devtools pill by default: hidden on the page and absent from the pixels', async () => {
    pillVisibility.length = 0;
    const result = await browser.capture(url('/'));
    expect(pillVisibility).toEqual(['hidden']);
    expect(result.layout!.hidden).toBeGreaterThanOrEqual(2); // the container and the pill
    // The pill sits at bottom-centre: 12 px from the bottom, 30 px tall.
    const img = decodePng(result.png);
    expect(img.pixel(640, img.height - 12 - 15)).toEqual([255, 255, 255]);
  });

  it('shows it when the default list is replaced by an empty one (control for the check above)', async () => {
    const bare = await Browser.launch({ ...h.config, hideSelectors: [] });
    try {
      const result = await bare.capture(url('/'));
      const img = decodePng(result.png);
      expect(img.pixel(640, img.height - 12 - 15)).toEqual(MAGENTA);
    } finally {
      await bare.close();
    }
  });

  it('ignores an invalid selector instead of failing the capture', async () => {
    const odd = await Browser.launch({ ...h.config, hideSelectors: ['#__vue-devtools-container__', '##broken[['] });
    try {
      const result = await odd.capture(url('/'));
      expect(result.signals.screenshotError).toBeUndefined();
      const img = decodePng(result.png);
      expect(img.pixel(640, img.height - 27)).toEqual([255, 255, 255]);
    } finally {
      await odd.close();
    }
  });
});
