import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from '../../src/browser.js';
import { parseConfig, type Config } from '../../src/config.js';
import { tmpDir } from '../unit/helpers.js';
import { decodePng } from './png.js';

/** A tiny app on localhost: each path is a page (or API) that isolates one flake control. */
let server: http.Server;
let port: number;
let closedPort: number;
const sockets = new Set<Socket>();
const logs: string[] = [];
const browsers: Browser[] = [];

const page = (body: string, head = '') =>
  `<!doctype html><html><head><style>body{margin:0}</style>${head}</head><body><div id="app">${body}</div></body></html>`;

const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void> = {
  '/clock': (_req, res) =>
    html(
      res,
      page(
        `<p id="now">pending</p><p id="timer">waiting</p><script>
          document.getElementById('now').textContent = new Date().toISOString();
          setTimeout(() => { document.getElementById('timer').textContent = 'timer-ran'; }, 40);
        </script>`,
      ),
    ),
  '/mask': (_req, res) =>
    html(
      res,
      page(`<h1>Title</h1><div id="secret" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:#00ff00">secret</div>`),
    ),
  '/tracker': (_req, res) =>
    html(res, page(`<p>content</p><img src="http://127.0.0.1:${closedPort}/pixel.png" width="1" height="1" alt="">`)),
  '/late': (_req, res) =>
    html(
      res,
      page(`<p id="msg">early</p><script>
        setTimeout(() => fetch('/api/slow').then((r) => r.text()).then((t) => { document.getElementById('msg').textContent = t; }), 1000);
      </script>`),
    ),
  '/hang': (_req, res) => html(res, page(`<p>hanging</p><script>fetch('/api/never').catch(() => {});</script>`)),
  '/api/slow': (_req, res) => setTimeout(() => res.end('late'), 50),
  '/api/never': () => {},
  '/login': (_req, res) => {
    res.writeHead(204, { 'set-cookie': 'sid=ok; Path=/; HttpOnly' });
    res.end();
  },
  '/api/private': (req, res) => {
    if (!/sid=ok/.test(req.headers.cookie ?? '')) return json(res, 401, { error: 'login' });
    json(res, 200, { data: [{ id: 41 }] });
  },
  '/api/boom': (_req, res) => json(res, 500, { error: 'boom' }),
  '/api/html': (_req, res) => html(res, '<p>not json</p>'),
};

function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
}
function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const handler = routes[new URL(req.url ?? '/', 'http://x').pathname];
    if (handler) handler(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;

  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, resolve));
  closedPort = (closed.address() as AddressInfo).port;
  await new Promise((resolve) => closed.close(resolve));
});

afterAll(async () => {
  await Promise.all(browsers.map((b) => b.close()));
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
});

function configure(extra: Record<string, unknown> = {}): Config {
  return parseConfig({ appUrl: `http://localhost:${port}`, ...extra }, tmpDir(), {});
}
async function launch(extra: Record<string, unknown> = {}): Promise<Browser> {
  const browser = await Browser.launch(configure(extra), { log: (m) => logs.push(m) });
  browsers.push(browser);
  return browser;
}
const url = (p: string) => `http://localhost:${port}${p}`;

describe('fixedTime', () => {
  it('freezes Date in every page, from before the first script runs, while timers keep running', async () => {
    const frozen = await launch({ fixedTime: '2026-01-15T09:00:00Z' });
    const first = await frozen.capture(url('/clock'));
    expect(first.signals.text).toContain('2026-01-15T09:00:00.000Z');
    expect(first.signals.text).toContain('timer-ran');
    await new Promise((r) => setTimeout(r, 300));
    const second = await frozen.capture(url('/clock'));
    expect(second.signals.text).toContain('2026-01-15T09:00:00.000Z'); // a later page gets the same instant
    expect(logs.some((l) => l.includes('clock fixed at 2026-01-15T09:00:00Z'))).toBe(true);
  });

  it('leaves time alone by default', async () => {
    const plain = await launch();
    const result = await plain.capture(url('/clock'));
    const shown = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/.exec(result.signals.text)?.[0];
    expect(shown).toBeDefined();
    expect(Math.abs(Date.parse(shown!) - Date.now())).toBeLessThan(60_000);
  });
});

describe('maskSelectors', () => {
  const MAGENTA = [255, 0, 255];
  const GREEN = [0, 255, 0];

  it('covers the matched elements with a solid box and keeps the layout', async () => {
    const plain = await launch();
    const masked = await launch({ maskSelectors: ['#secret'] });
    const before = decodePng((await plain.capture(url('/mask'))).png);
    const result = await masked.capture(url('/mask'));
    const after = decodePng(result.png);

    expect(before.pixel(200, 130)).toEqual(GREEN);
    expect(after.pixel(200, 130)).toEqual(MAGENTA);
    expect(after.pixel(110, 110)).toEqual(MAGENTA);
    expect(after.pixel(290, 150)).toEqual(MAGENTA);
    expect(after.pixel(320, 130)).toEqual(before.pixel(320, 130)); // outside the box nothing changed
    expect(result.layout).toMatchObject({ masked: 1 });
    expect(before.width).toBe(after.width);
    expect(before.height).toBe(after.height);
  });

  it('ignores selectors that match nothing, and logs one that is not a valid selector (once)', async () => {
    logs.length = 0;
    const browser = await launch({ maskSelectors: ['#nothing-here', '[[[', '#secret'] });
    const first = await browser.capture(url('/mask'));
    await browser.capture(url('/mask'));
    expect(first.signals.screenshotError).toBeUndefined();
    expect(decodePng(first.png).pixel(200, 130)).toEqual([255, 0, 255]);
    expect(logs.filter((l) => l.includes('maskSelectors entry "[[["'))).toHaveLength(1);
  });
});

describe('blockHosts and allowHosts', () => {
  const tracker = `127.0.0.1`;

  it('without blocking, a request to a dead host is a console error and the frame is an error', async () => {
    const open = await launch({ blockHosts: [] });
    const result = await open.capture(url('/tracker'));
    expect(result.signals.consoleErrors.some((m) => m.includes('Failed to load resource'))).toBe(true);
  });

  it('aborts requests to blocked hosts before navigation, and the aborted request is not a console error', async () => {
    const blocking = await launch({ blockHosts: [tracker] });
    const result = await blocking.capture(url('/tracker'));
    expect(result.signals.consoleErrors).toEqual([]);
    expect(result.signals.pageErrors).toEqual([]);
    expect(result.signals.text).toContain('content');
  });

  it('allowHosts exempts a host from the block list', async () => {
    const allowed = await launch({ blockHosts: [tracker], allowHosts: [tracker] });
    const result = await allowed.capture(url('/tracker'));
    expect(result.signals.consoleErrors.some((m) => m.includes('Failed to load resource'))).toBe(true);
  });

  it('never blocks the app itself, even with a catch-all', async () => {
    const all = await launch({ blockHosts: ['*'] });
    const result = await all.capture(url('/tracker'));
    expect(result.signals.text).toContain('content');
    expect(result.signals.navOk).toBe(true);
    expect(result.signals.consoleErrors).toEqual([]);
  });

  it('the default list leaves ordinary hosts alone: a dead 127.0.0.1 request still errors', async () => {
    const defaults = await launch();
    const result = await defaults.capture(url('/tracker'));
    expect(result.signals.consoleErrors.some((m) => m.includes('Failed to load resource'))).toBe(true);
  });
});

describe('settle', () => {
  it('a short idle window settles before a late request starts; a long one waits for it', async () => {
    const quick = await launch({ settle: { networkIdleMs: 100 } });
    const patient = await launch({ settle: { networkIdleMs: 1500 } });
    expect((await quick.capture(url('/late'))).signals.text).toBe('early');
    expect((await patient.capture(url('/late'))).signals.text).toBe('late');
  });

  it('maxWaitMs bounds the wait for a request that never finishes', async () => {
    const capped = await launch({ settle: { networkIdleMs: 100, maxWaitMs: 700 } });
    const t0 = Date.now();
    const result = await capped.capture(url('/hang'));
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(result.timing!.settleMs).toBeGreaterThanOrEqual(600);
    expect(result.signals.text).toContain('hanging');
  });

  it('reports where the time went', async () => {
    const browser = await launch();
    const result = await browser.capture(url('/mask'));
    expect(result.timing).toBeDefined();
    expect(result.timing!.settleMs).toBeGreaterThanOrEqual(150); // the default 250 ms idle window, less what load already used
    expect(result.timing!.screenshotMs).toBeGreaterThan(0);
  });
});

describe('getJson (paramSources fetch)', () => {
  it('logs in first and sends the session cookie, so an authenticated endpoint answers', async () => {
    const browser = await launch({ login: { type: 'http-hook', url: '/login', email: 'a@b.test' } });
    expect(await browser.getJson('/api/private')).toEqual({ status: 200, json: { data: [{ id: 41 }] } });
  });

  it('answers 401 for a closed endpoint without a login hook', async () => {
    const browser = await launch();
    expect(await browser.getJson('/api/private')).toEqual({ status: 401, error: 'HTTP 401' });
  });

  it('reports HTTP errors, non-JSON bodies and unreachable hosts as errors', async () => {
    const browser = await launch();
    expect(await browser.getJson('/api/boom')).toEqual({ status: 500, error: 'HTTP 500' });
    expect(await browser.getJson('/api/html')).toEqual({ status: 200, error: 'response is not JSON' });
    const dead = await launch({ appUrl: `http://localhost:${closedPort}` });
    const unreachable = await dead.getJson('/api/x');
    expect(unreachable.status).toBe(0);
    expect(unreachable.error).toBeTruthy();
  });
});
