import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { readDom } from '../../src/browser.js';

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
afterAll(async () => { await browser?.close(); });

describe('readDom visible overlays', () => {
  it('captures a teleported BModal, other body UI and nested dialogs once, while excluding hidden content', async () => {
    await page.setContent(`<div id="app"><main>Promotion</main><div role="dialog">Inside app</div></div>
      <div style="position:absolute;width:0;height:0"><div role="dialog" aria-modal="true" class="modal show" style="position:fixed;inset:40px">
        Archive promotion<div role="dialog">This will also archive 3 promotion codes.</div>
      </div></div>
      <aside>Visible notification</aside><div role="dialog" hidden>Hidden warning</div>
      <div style="opacity:0"><div role="dialog">Transparent warning</div></div><script type="text/plain">Secret script</script>`);
    const dom = await readDom(page, '#app', []);
    expect(dom).toMatchObject({ appRootPresent: true, appRootChildCount: 2 });
    expect(dom!.fullText).toContain('This will also archive 3 promotion codes.');
    expect(dom!.fullText).toContain('Promotion');
    expect(dom!.fullText).toContain('Visible notification');
    expect(dom!.fullText.match(/This will also archive/g)).toHaveLength(1);
    expect(dom!.fullText.match(/Inside app/g)).toHaveLength(1);
    expect(dom!.fullText).not.toMatch(/Hidden warning|Transparent warning|Secret script/);
  });

  it('keeps overlay evidence when the app is long and respects the UTF-8 page cap', async () => {
    await page.setContent(`<div id="app">${'漢😀'.repeat(10_000)}</div><div class="modal show">Archive 3 promotion codes</div>`);
    const dom = await readDom(page, '#app', []);
    expect(dom!.fullText).toMatch(/^Archive 3 promotion codes/);
    expect(dom!.fullText.match(/Archive 3 promotion codes/g)).toHaveLength(1);
    expect(Buffer.byteLength(dom!.fullText)).toBeLessThanOrEqual(8192);
    expect(dom!.fullText).not.toContain('\ufffd');
    expect(dom!.text.length).toBeLessThanOrEqual(2048);
  });
});
