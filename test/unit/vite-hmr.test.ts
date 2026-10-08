import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { tmpDir } from './helpers.js';
import { parseHmrPort, parseWsToken, socketUrl, ViteHmrClient } from '../../src/trigger/vite-hmr.js';

describe('parseWsToken / socketUrl', () => {
  const source = `const hmrPort = null;\nconst wsToken = "OdcjxuRwBe2Z";\nconst x = 1;`;

  it('reads the token from the client source', () => {
    expect(parseWsToken(source)).toBe('OdcjxuRwBe2Z');
    expect(parseWsToken('no token here')).toBeNull();
  });

  it('reads a fixed hmr port', () => {
    expect(parseHmrPort(source)).toBeNull();
    expect(parseHmrPort('const hmrPort = 24678;')).toBe(24678);
  });

  it('builds ws and wss urls, keeping the base path and honouring hmrPort', () => {
    expect(socketUrl('http://localhost:5173', 'tok')).toBe('ws://localhost:5173/?token=tok');
    expect(socketUrl('https://app.test', 'a/b')).toBe('wss://app.test/?token=a%2Fb');
    expect(socketUrl('http://localhost:5173/base', 't')).toBe('ws://localhost:5173/base/?token=t');
    expect(socketUrl('http://localhost:5173', 't', 24678)).toBe('ws://localhost:24678/?token=t');
    expect(socketUrl('http://localhost:5173', null)).toBe('ws://localhost:5173/');
  });
});

/** A stand-in for Vite: serves `/@vite/client` with a token and a `vite-hmr` websocket that checks it. */
class FakeVite {
  readonly server: http.Server | https.Server;
  readonly wss: WebSocketServer;
  token = 'tok-1';
  clientFetches = 0;
  accepted = 0;
  rejected = 0;
  sockets = new Set<WebSocket>();

  constructor(tls?: https.ServerOptions) {
    const handler: http.RequestListener = (req, res) => {
      this.clientFetches++;
      if (req.url === '/@vite/client') {
        res.end(`const hmrPort = null;\nconst wsToken = "${this.token}";\n`);
      } else {
        res.statusCode = 404;
        res.end();
      }
    };
    this.server = tls ? https.createServer(tls, handler) : http.createServer(handler);
    this.wss = new WebSocketServer({
      server: this.server,
      handleProtocols: (protocols) => (protocols.has('vite-hmr') ? 'vite-hmr' : false),
      verifyClient: ({ req }: { req: http.IncomingMessage }) => {
        const ok = new URL(req.url!, 'http://x').searchParams.get('token') === this.token;
        if (ok) this.accepted++;
        else this.rejected++;
        return ok;
      },
    });
    this.wss.on('connection', (ws) => {
      this.sockets.add(ws);
      ws.on('close', () => this.sockets.delete(ws));
      ws.send(JSON.stringify({ type: 'connected' }));
    });
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve) => this.server.listen(port, '127.0.0.1', () => resolve((this.server.address() as AddressInfo).port)));
  }

  send(payload: unknown): void {
    for (const ws of this.sockets) ws.send(JSON.stringify(payload));
  }

  async close(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
}

let vite: FakeVite;
let client: ViteHmrClient | null;
let port: number;

beforeEach(async () => {
  vite = new FakeVite();
  port = await vite.listen();
  client = null;
});
afterEach(async () => {
  await client?.stop();
  await vite.close().catch(() => {});
});

function makeClient(overrides: Partial<ConstructorParameters<typeof ViteHmrClient>[0]> = {}): ViteHmrClient {
  client = new ViteHmrClient({
    viteUrl: `http://127.0.0.1:${port}`,
    initialBackoffMs: 20,
    maxBackoffMs: 80,
    ...overrides,
  });
  return client;
}

describe('ViteHmrClient', () => {
  it('fetches the token, connects with the vite-hmr subprotocol, and reports state', async () => {
    const c = makeClient();
    expect(c.state).toBe('disconnected');
    c.start();
    expect(await c.waitForConnected(2000)).toBe(true);
    expect(c.state).toBe('connected');
    expect(vite.accepted).toBe(1);
    await c.stop();
    expect(c.state).toBe('disconnected');
  });

  it('resolves hmr on an update message and on a full-reload', async () => {
    const c = makeClient();
    c.start();
    await c.waitForConnected(2000);

    let p = c.waitForNextMessage(2000);
    vite.send({ type: 'update', updates: [] });
    expect(await p).toBe('hmr');

    p = c.waitForNextMessage(2000);
    vite.send({ type: 'full-reload' });
    expect(await p).toBe('hmr');
  });

  it('ignores connected, ping, prune, error and unparseable payloads and times out', async () => {
    const c = makeClient();
    c.start();
    await c.waitForConnected(2000);
    const p = c.waitForNextMessage(200);
    vite.send({ type: 'connected' });
    vite.send({ type: 'ping' });
    vite.send({ type: 'prune', paths: [] });
    vite.send({ type: 'error', err: {} });
    for (const ws of vite.sockets) ws.send('not json');
    const started = Date.now();
    expect(await p).toBe('timeout');
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it('times out when never connected', async () => {
    await vite.close();
    const c = makeClient();
    c.start();
    expect(await c.waitForNextMessage(100)).toBe('timeout');
    expect(c.state).toBe('disconnected');
  });

  it('credits a barrier message that arrived since a given time', async () => {
    const c = makeClient();
    c.start();
    await c.waitForConnected(2000);
    const before = Date.now() - 1;
    vite.send({ type: 'update', updates: [] });
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    expect(await c.waitForNextMessage(2000, { since: before })).toBe('hmr');
    expect(Date.now() - started).toBeLessThan(100);
    // A message older than `since` does not count.
    expect(await c.waitForNextMessage(80, { since: Date.now() })).toBe('timeout');
  });

  it('reconnects after a drop and re-fetches the token when the server restarted', async () => {
    const c = makeClient();
    c.start();
    await c.waitForConnected(2000);
    expect(vite.clientFetches).toBe(1);

    // Simulate a dev-server restart on the same port with a new token.
    await vite.close();
    vite = new FakeVite();
    vite.token = 'tok-2';
    await vite.listen(port);

    // The old socket's close may still be in flight; wait out the stale 'connected'.
    while (c.state === 'connected') await new Promise((r) => setTimeout(r, 5));
    expect(await c.waitForConnected(5000)).toBe(true);
    expect(vite.accepted).toBe(1);
    expect(vite.rejected).toBe(0);

    const p = c.waitForNextMessage(2000);
    vite.send({ type: 'update', updates: [] });
    expect(await p).toBe('hmr');
  });

  it('keeps retrying with backoff while the server is down, then connects', async () => {
    await vite.close();
    const states: string[] = [];
    const c = makeClient();
    c.on('state', (s) => states.push(s));
    c.start();
    await new Promise((r) => setTimeout(r, 250));
    expect(c.state).toBe('disconnected');
    vite = new FakeVite();
    await vite.listen(port);
    expect(await c.waitForConnected(5000)).toBe(true);
    expect(states).toEqual(['connected']);
  });

  it('stop resolves pending waiters and prevents reconnects', async () => {
    const c = makeClient();
    c.start();
    await c.waitForConnected(2000);
    const p = c.waitForNextMessage(5000);
    await c.stop();
    expect(await p).toBe('timeout');
    await new Promise((r) => setTimeout(r, 150));
    expect(vite.accepted).toBe(1);
  });
});

describe('ViteHmrClient over TLS', () => {
  let openssl = true;
  let tls: https.ServerOptions | undefined;
  try {
    const dir = tmpDir('vp-tls-');
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'],
      { stdio: 'ignore' },
    );
    tls = { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  } catch {
    openssl = false;
  }

  it.skipIf(!openssl)('connects over wss to a self-signed server only when ignoreHTTPSErrors is set', async () => {
    const secure = new FakeVite(tls);
    const securePort = await secure.listen();
    const strict = new ViteHmrClient({ viteUrl: `https://127.0.0.1:${securePort}`, initialBackoffMs: 20, maxBackoffMs: 40 });
    const lenient = new ViteHmrClient({
      viteUrl: `https://127.0.0.1:${securePort}`,
      ignoreHTTPSErrors: true,
      initialBackoffMs: 20,
    });
    try {
      strict.start();
      expect(await strict.waitForConnected(400)).toBe(false);
      lenient.start();
      expect(await lenient.waitForConnected(3000)).toBe(true);
      const p = lenient.waitForNextMessage(2000);
      secure.send({ type: 'update', updates: [] });
      expect(await p).toBe('hmr');
    } finally {
      await strict.stop();
      await lenient.stop();
      await secure.close();
    }
  });
});
