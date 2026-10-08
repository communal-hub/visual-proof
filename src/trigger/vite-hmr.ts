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

/** One `update` / `full-reload` message, kept briefly so a barrier wait can be credited with one that beat it. */
interface BarrierMessage {
  at: number;
  /** `full-reload` invalidates everything; an `update` only the listed modules. */
  full: boolean;
  /** URL paths named by an `update` (`path` and `acceptedPath` of each entry), normalised: no query, no leading slash. */
  paths: Set<string>;
}

interface Waiter {
  /** Normalised repo-relative paths this wait cares about; undefined means any barrier message. */
  files: Set<string> | undefined;
  resolve: (result: BarrierResult) => void;
}

const RECENT_MESSAGE_MS = 30_000;
const RECENT_MESSAGE_MAX = 100;

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
  private recent: BarrierMessage[] = [];
  private readonly waiters = new Set<Waiter>();
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
    for (const waiter of [...this.waiters]) waiter.resolve('timeout');
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
   * Resolve `hmr` on the next barrier message, else `timeout`. A barrier message is `full-reload`
   * (always) or an `update` that names one of `files` (repo-relative paths, matched against each
   * entry's `path` and `acceptedPath`, which are URL paths such as `/src/pages/A.vue`). An `update`
   * for some other module says nothing about the files being waited on. Without `files`, any
   * barrier message counts. With `since` (epoch ms), a matching message that already arrived at or
   * after that time counts, which covers Vite announcing the change before the caller's own
   * debounce finished.
   */
  waitForNextMessage(timeoutMs: number, options: { since?: number; files?: string[] } = {}): Promise<BarrierResult> {
    const files = options.files ? new Set(options.files.map((f) => normalizePath(f, ''))) : undefined;
    if (options.since !== undefined) {
      const since = options.since;
      if (this.recent.some((m) => m.at >= since && matches(m, files))) return Promise.resolve('hmr');
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        files,
        resolve: (result) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(result);
        },
      };
      const timer = setTimeout(() => waiter.resolve('timeout'), timeoutMs);
      this.waiters.add(waiter);
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
    let payload: { type?: unknown; updates?: unknown };
    try {
      payload = JSON.parse(text) as { type?: unknown; updates?: unknown };
    } catch {
      return;
    }
    const basePath = new URL(withTrailingSlash(this.options.viteUrl)).pathname;
    let message: BarrierMessage;
    if (payload.type === 'full-reload') {
      message = { at: Date.now(), full: true, paths: new Set() };
    } else if (payload.type === 'update') {
      const paths = new Set<string>();
      for (const update of Array.isArray(payload.updates) ? (payload.updates as unknown[]) : []) {
        if (typeof update !== 'object' || update === null) continue;
        const { path, acceptedPath } = update as { path?: unknown; acceptedPath?: unknown };
        for (const p of [path, acceptedPath]) if (typeof p === 'string') paths.add(normalizePath(p, basePath));
      }
      message = { at: Date.now(), full: false, paths };
    } else {
      return;
    }
    this.recent = [...this.recent.filter((m) => message.at - m.at <= RECENT_MESSAGE_MS), message].slice(-RECENT_MESSAGE_MAX);
    for (const waiter of [...this.waiters]) if (matches(message, waiter.files)) waiter.resolve('hmr');
  }
}

/** Whether a barrier message tells a waiter that its files were invalidated. */
function matches(message: BarrierMessage, files: Set<string> | undefined): boolean {
  if (message.full || files === undefined) return true;
  for (const file of files) if (message.paths.has(file)) return true;
  return false;
}

/** `/base/src/A.vue?vue&type=style#x` -> `src/A.vue`: no query or hash, no `base` prefix, no leading slash. */
function normalizePath(urlPath: string, basePath: string): string {
  let p = urlPath.replace(/[?#].*$/, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep the raw path
  }
  if (basePath !== '' && basePath !== '/' && p.startsWith(basePath)) p = p.slice(basePath.length);
  return p.replace(/^\/+/, '');
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
