import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';

export type HmrState = 'connected' | 'disconnected';
export type BarrierResult = 'hmr' | 'timeout';

export interface ViteHmrOptions {
  /** Base URL of the Vite dev server (the page origin, plus `base` if the app is served under one). */
  viteUrl: string;
  /** Accept self-signed certificates for the token fetch and the websocket. */
  ignoreHTTPSErrors?: boolean;
  /** First reconnect delay; doubles up to `maxBackoffMs`. Defaults 250 ms / 5 s. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Per-attempt cap for the token fetch and the websocket handshake. Default 3 s. */
  connectTimeoutMs?: number;
  log?: (message: string) => void;
}

/** Vite HMR payload types that mean "the module graph was just invalidated and clients should refetch". */
const BARRIER_TYPES = new Set(['update', 'full-reload']);

/**
 * `const wsToken = "..."` from the served `/@vite/client`. Returns null when absent (Vite < 5.1
 * has no token; connecting without one still works there).
 */
export function parseWsToken(clientSource: string): string | null {
  return /const wsToken = "([^"]+)"/.exec(clientSource)?.[1] ?? null;
}

/** `const hmrPort = 24678;` from the client source, or null when the socket shares the page port. */
export function parseHmrPort(clientSource: string): number | null {
  const m = /const hmrPort = (\d+)/.exec(clientSource);
  return m ? Number(m[1]) : null;
}

/** `ws(s)://<host>[:port]<base>?token=<token>` for a Vite URL. */
export function socketUrl(viteUrl: string, token: string | null, hmrPort: number | null = null): string {
  const url = new URL(viteUrl);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = hmrPort ? `${url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname}:${hmrPort}` : url.host;
  const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `${protocol}//${host}${pathname}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

/**
 * Node-side Vite HMR websocket client, used as a freshness barrier: after a source file changes,
 * `waitForNextMessage` resolves as soon as Vite has announced an `update`/`full-reload`, i.e. after
 * it invalidated the module, or `timeout` otherwise (modules not in Vite's graph send nothing, and
 * have no cached transform either).
 *
 * Emits `state` (HmrState) on every connection change.
 */
export class ViteHmrClient extends EventEmitter {
  state: HmrState = 'disconnected';

  private ws: WebSocket | null = null;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs: number;
  private lastBarrierAt = 0;
  private readonly waiters = new Set<(result: BarrierResult) => void>();
  private abort = new AbortController();

  constructor(private readonly options: ViteHmrOptions) {
    super();
    this.backoffMs = options.initialBackoffMs ?? 250;
  }

  /** Begin connecting in the background. Returns immediately; use `waitForConnected` to await it. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.abort = new AbortController();
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
    }
    this.setState('disconnected');
    for (const resolve of [...this.waiters]) resolve('timeout');
  }

  /** Resolves true once connected, false after `timeoutMs` without a connection. */
  waitForConnected(timeoutMs: number): Promise<boolean> {
    if (this.state === 'connected') return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value: boolean): void => {
        clearTimeout(timer);
        this.off('state', onState);
        resolve(value);
      };
      const onState = (state: HmrState): void => {
        if (state === 'connected') done(true);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.on('state', onState);
    });
  }

  /**
   * Resolve `hmr` on the next `update` or `full-reload` message, else `timeout`. With
   * `since` (epoch ms), a barrier message that already arrived at or after that time counts, which
   * covers Vite announcing the change before the caller's own debounce finished.
   */
  waitForNextMessage(timeoutMs: number, options: { since?: number } = {}): Promise<BarrierResult> {
    if (options.since !== undefined && this.lastBarrierAt >= options.since) return Promise.resolve('hmr');
    return new Promise((resolve) => {
      const done = (result: BarrierResult): void => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(result);
      };
      const timer = setTimeout(() => done('timeout'), timeoutMs);
      this.waiters.add(done);
    });
  }

  private setState(state: HmrState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const timeoutMs = this.options.connectTimeoutMs ?? 3000;
    try {
      // Re-fetched on every attempt: a restarted dev server issues a new token.
      const source = await fetchText(new URL('@vite/client', withTrailingSlash(this.options.viteUrl)).href, {
        ignoreHTTPSErrors: this.options.ignoreHTTPSErrors ?? false,
        timeoutMs,
        signal: this.abort.signal,
      });
      if (this.stopped) return;
      const url = socketUrl(this.options.viteUrl, parseWsToken(source), parseHmrPort(source));
      await this.openSocket(url, timeoutMs);
    } catch (err) {
      if (this.stopped) return;
      this.log(`hmr: connect failed (${(err as Error).message}); retrying in ${this.backoffMs} ms`);
      this.scheduleReconnect();
    }
  }

  private openSocket(url: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, 'vite-hmr', {
        rejectUnauthorized: !(this.options.ignoreHTTPSErrors ?? false),
        handshakeTimeout: timeoutMs,
      });
      this.ws = ws;
      let opened = false;

      ws.on('open', () => {
        opened = true;
        this.backoffMs = this.options.initialBackoffMs ?? 250;
        this.setState('connected');
        this.log('hmr: connected');
        resolve();
      });
      ws.on('message', (data) => this.onMessage(data.toString()));
      ws.on('error', (err) => {
        if (!opened) reject(err);
      });
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
        this.setState('disconnected');
        if (this.stopped) return;
        if (opened) {
          this.log('hmr: disconnected');
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 5000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private onMessage(text: string): void {
    let type: unknown;
    try {
      type = (JSON.parse(text) as { type?: unknown }).type;
    } catch {
      return;
    }
    if (typeof type !== 'string' || !BARRIER_TYPES.has(type)) return;
    this.lastBarrierAt = Date.now();
    for (const resolve of [...this.waiters]) resolve('hmr');
  }
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function fetchText(
  url: string,
  options: { ignoreHTTPSErrors: boolean; timeoutMs: number; signal: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(
      url,
      { rejectUnauthorized: !options.ignoreHTTPSErrors, signal: options.signal, timeout: options.timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve(body));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on('error', reject);
  });
}
