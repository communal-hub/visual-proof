import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from '../../src/browser.js';
import { triage } from '../../src/triage.js';
import { createHarness, type Harness } from './harness.js';

let h: Harness;
let browser: Browser;
const logs: string[] = [];

beforeAll(async () => {
  h = await createHarness();
  browser = await Browser.launch(h.config, { log: (m) => logs.push(m) });
});
afterAll(async () => {
  await browser?.close();
  await h?.cleanup();
});

const url = (p: string) => `${h.appUrl}${p}`;
const openPages = () => (browser as unknown as { context: { pages(): unknown[] } }).context.pages().length;
const clearCookies = () => (browser as unknown as { context: { clearCookies(): Promise<void> } }).context.clearCookies();

describe('Browser.capture', () => {
  it('logs in through the hook and returns a PNG plus triage signals, leaving no page open', async () => {
    const result = await browser.capture(url('/manage/invoices/1'));
    expect(result.png.subarray(1, 4).toString()).toBe('PNG');
    expect(result.png.length).toBeGreaterThan(1000);
    expect(result.finalUrl).toBe(url('/manage/invoices/1'));
    expect(result.signals).toMatchObject({
      navOk: true,
      httpStatus: 200,
      consoleErrors: [],
      pageErrors: [],
      appRootPresent: true,
      visibleSpinnerCount: 0,
    });
    expect(result.signals.appRootChildCount).toBeGreaterThan(0);
    expect(result.signals.text).toContain('INV-001');
    expect(result.signals.text.length).toBeLessThanOrEqual(2048);
    expect(triage(result.signals).status).toBe('clean');
    expect(openPages()).toBe(0);
  });

  it('waits for data to load rather than shooting the spinner', async () => {
    const result = await browser.capture(url('/manage/invoices'));
    expect(result.signals.visibleSpinnerCount).toBe(0);
    expect(result.signals.text).toContain('INV-002');
  });

  it('captures a public route and a client-side 404-less route', async () => {
    const home = await browser.capture(url('/'));
    expect(triage(home.signals).status).toBe('clean');
  });

  it('logs in again when the session is gone (redirect to /login), then captures the real page', async () => {
    await clearCookies();
    const result = await browser.capture(url('/manage/invoices/1'));
    expect(result.finalUrl).toBe(url('/manage/invoices/1'));
    expect(result.signals.text).toContain('INV-001');
    expect(result.signals.authFailure).toBeUndefined();
    expect(logs.some((l) => l.includes('redirected to /login; logging in again'))).toBe(true);
    expect(openPages()).toBe(0);
  });

  it('re-reads the token file on every login (the fixture server rotates it too)', async () => {
    const tokenFile = path.join(h.dir, '.visual-proof/token');
    fs.writeFileSync(tokenFile, 'rotated-token\n');
    await clearCookies();
    const result = await browser.capture(url('/manage/invoices/1'));
    expect(result.signals.authFailure).toBeUndefined();
    expect(triage(result.signals).status).toBe('clean');
  });

  it('turns a rejected login into an error frame naming the HTTP status', async () => {
    fs.writeFileSync(path.join(h.dir, 'wrong-token'), 'nope\n');
    const bad = await Browser.launch({ ...h.config, login: { ...h.config.login, tokenFile: 'wrong-token' } });
    try {
      const result = await bad.capture(url('/manage/invoices/1'));
      expect(result.signals.authFailure).toBe('login failed: HTTP 403 from /__playwright__/login');
      expect(triage(result.signals)).toMatchObject({ status: 'error' });
      expect(triage(result.signals).reasons[0]).toContain('login failed: HTTP 403');
    } finally {
      await bad.close();
    }
  });

  it('reports navigation failures as an error frame with a (blank) screenshot instead of throwing', async () => {
    const result = await browser.capture('http://localhost:1/never');
    expect(result.signals.navOk).toBe(false);
    expect(result.png.length).toBeGreaterThan(0);
    expect(triage(result.signals)).toMatchObject({ status: 'error', reasons: ['navigation failed'] });
    expect(openPages()).toBe(0);
  });

  it('turns a screenshot that throws into an error frame instead of a clean one with a placeholder PNG', async () => {
    const internals = browser as unknown as { context: { newPage(): Promise<{ screenshot: unknown }> } };
    const realNewPage = internals.context.newPage.bind(internals.context);
    internals.context.newPage = async () => {
      const page = await realNewPage();
      page.screenshot = () => Promise.reject(new Error('Protocol error (Page.captureScreenshot): Target closed\n  at ...'));
      return page;
    };
    try {
      const result = await browser.capture(url('/'));
      expect(result.signals.screenshotError).toBe('Protocol error (Page.captureScreenshot): Target closed');
      expect(triage(result.signals)).toEqual({
        status: 'error',
        reasons: ['screenshot failed: Protocol error (Page.captureScreenshot): Target closed'],
      });
    } finally {
      internals.context.newPage = realNewPage;
    }
  });

  it('close is idempotent', async () => {
    const extra = await Browser.launch(h.config);
    await extra.close();
    await expect(extra.close()).resolves.toBeUndefined();
  });

  it('captures again when a cold Vite answers 504 "Outdated Optimize Dep", instead of reporting an error frame', async () => {
    let scriptRequests = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/dep.js') {
        scriptRequests++;
        if (scriptRequests === 1) {
          res.writeHead(504, 'Outdated Optimize Dep').end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/javascript' }).end("document.getElementById('app').innerHTML = '<p>ready</p>'");
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end('<div id="app"></div><script src="/dep.js"></script>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const result = await browser.capture(target);
      expect(scriptRequests).toBe(2);
      expect(result.signals.consoleErrors).toEqual([]);
      expect(result.signals.text).toBe('ready');
      expect(triage(result.signals).status).toBe('clean');
      expect(logs.some((l) => l.includes('Outdated Optimize Dep'))).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
