import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { Browser, type Capturer, type CaptureSignals } from './browser.js';
import type { Config } from './config.js';
import { headCommit, workingTreeHash } from './git.js';
import { ensureDirs, resolveDirs, statusFiles, type Dirs } from './paths.js';
import { buildImportGraph, type ImportGraph } from './resolve/import-graph.js';
import { joinUrl, resolveRoutes } from './resolve/routes.js';
import { Timeline, type Frame, type Trigger } from './timeline.js';
import { startFsWatch, type FsWatchHandle, type WatchBatch } from './trigger/fs-watch.js';
import { ViteHmrClient, type BarrierResult, type HmrState } from './trigger/vite-hmr.js';
import { type DaemonState, type Status } from './status.js';
import { triage } from './triage.js';

export type { DaemonState, Status };

/** The slice of the HMR client that `watch` relies on; tests substitute a fake. */
export interface BarrierSource {
  readonly state: HmrState;
  start(): void;
  stop(): Promise<void>;
  waitForNextMessage(timeoutMs: number, options?: { since?: number; files?: string[] }): Promise<BarrierResult>;
  waitForConnected(timeoutMs: number): Promise<boolean>;
  on(event: 'state', listener: (state: HmrState) => void): unknown;
}

export interface WatchOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the status/artifact/scratch dirs (default: resolved from `env`). */
  dirs?: Dirs;
  sessionId?: string;
  /** Extra sink for log lines (the file `watcher.log` is always written). */
  log?: (line: string) => void;
  /** Injected browser; `watch` takes ownership and closes it on stop. Default: launch headless Chromium. */
  capturer?: Capturer;
  /** Injected freshness barrier, or `null` for timeout-only mode. Default: a {@link ViteHmrClient} on `config.viteUrl`. */
  barrier?: BarrierSource | null;
  startTrigger?: typeof startFsWatch;
  treeHash?: (repoDir: string, scratchDir: string) => Promise<string>;
  buildGraph?: (config: Config) => Promise<ImportGraph>;
  /** HEAD's commit sha, recorded as `anchor` in status.json. Default: `git rev-parse HEAD`. */
  headCommit?: (repoDir: string) => Promise<string | null>;
  /** How long to wait for an HMR message after a screen change. Default 500 ms. */
  barrierTimeoutMs?: number;
  debounceMs?: number;
  /** How many times a batch whose tree changed mid-capture is re-queued before it is dropped. Default 2. */
  maxRequeues?: number;
}

export interface FrameEvent {
  frame: Frame;
  signals: CaptureSignals;
  /** Absolute path of the PNG in the scratch dir. */
  pngPath: string;
}

export interface BatchEvent {
  screen: string[];
  backend: string[];
  routes: string[];
  outcome: 'captured' | 'refused' | 'discarded' | 'no-routes' | 'error';
}

export interface WatchHandle {
  sessionId: string;
  /** Emits `frame` (FrameEvent), `refused`, `discarded`, `error` (Error) and `batch` (BatchEvent, after each batch). */
  events: EventEmitter;
  stop(): Promise<void>;
}

interface Pending {
  screen: Set<string>;
  backend: Set<string>;
  startedAt: number;
  attempts: number;
}

interface Target {
  path: string;
  routeKey: string;
  url: string;
  trigger: Trigger;
  sourceFile?: string;
}

const STALE_MESSAGE = 'stale: freshness marker missing, capture refused';

export async function startWatch(config: Config, opts: WatchOptions = {}): Promise<WatchHandle> {
  const watcher = new Watcher(config, opts);
  await watcher.start();
  return watcher.handle;
}

class Watcher {
  readonly events = new EventEmitter();
  readonly handle: WatchHandle;
  private readonly dirs: Dirs;
  private readonly files: ReturnType<typeof statusFiles>;
  private readonly sessionId: string;
  private readonly timeline: Timeline;
  private readonly status: Status;
  private readonly isRouteFile: (file: string) => boolean;

  private capturer: Capturer | null = null;
  private barrier: BarrierSource | null = null;
  private trigger: FsWatchHandle | null = null;

  private pending: Pending | null = null;
  /** True from the first file event of a change until its batch is handed to {@link enqueue}. */
  private debouncing = false;
  private running: Promise<void> | null = null;
  private stopping = false;
  private stopped: Promise<void> | null = null;

  private graph: Promise<ImportGraph> | null = null;
  private graphStale = false;
  /** Concrete path -> route, for every route that produced a frame this session. */
  private readonly sessionRoutes = new Map<string, { routeKey: string; url: string }>();

  constructor(
    private readonly config: Config,
    private readonly opts: WatchOptions,
  ) {
    this.dirs = opts.dirs ?? resolveDirs(opts.env);
    this.files = statusFiles(this.dirs);
    this.sessionId = opts.sessionId ?? `s-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    this.timeline = new Timeline(this.dirs.scratchDir, config.maxFrames);
    this.isRouteFile = picomatch(config.routeFiles, { dot: true });
    this.status = {
      state: 'starting',
      sessionId: this.sessionId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      trigger: 'fs-watch',
      barrier: 'timeout-only',
      anchor: null,
      lastCaptureAt: null,
      lastEventAt: null,
      pending: false,
      pendingSince: null,
      lastError: null,
      frames: 0,
    };
    this.handle = { sessionId: this.sessionId, events: this.events, stop: () => this.stop() };
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    ensureDirs(this.dirs);
    this.log(`session ${this.sessionId} starting for ${this.config.repoDir}`);
    this.writeStatus();

    try {
      const treeHash = this.opts.treeHash ?? workingTreeHash;
      await treeHash(this.config.repoDir, this.dirs.scratchDir); // fail fast outside a git repo
      this.status.anchor = await (this.opts.headCommit ?? headCommit)(this.config.repoDir).catch(() => null);

      await this.startBarrier();

      this.capturer =
        this.opts.capturer ??
        (await Browser.launch(this.config, { log: (m) => this.log(`browser: ${m}`) }));
      await this.capturer.warm();

      this.graph = this.loadGraph();
      this.graph.catch(() => {}); // surfaced on first use, not as an unhandled rejection
      void this.logGraphSummary();

      const startTrigger = this.opts.startTrigger ?? startFsWatch;
      this.trigger = await startTrigger({
        repoDir: this.config.repoDir,
        screenGlobs: this.config.screenGlobs,
        ignoreScreenGlobs: this.config.ignoreScreenGlobs,
        backendGlobs: this.config.backendGlobs,
        ignorePaths: [this.dirs.statusDir, this.dirs.scratchDir, this.dirs.artifactDir],
        debounceMs: this.opts.debounceMs,
        onEvent: () => this.onFileEvent(),
        onBatch: (batch) => this.enqueue(batch),
        onError: (err) => this.fail(err),
      });
    } catch (err) {
      this.status.lastError = (err as Error).message;
      this.status.state = 'error';
      this.writeStatus();
      this.log(`startup failed: ${(err as Error).message}`);
      await this.teardown();
      throw err;
    }

    this.status.state = 'ready';
    this.writeStatus();
    this.log(`ready (trigger=fs-watch, barrier=${this.status.barrier})`);
  }

  stop(): Promise<void> {
    this.stopped ??= this.doStop();
    return this.stopped;
  }

  private async doStop(): Promise<void> {
    this.stopping = true;
    this.pending = null;
    this.debouncing = false;
    await this.trigger?.stop().catch(() => {});
    if (this.running) await Promise.race([this.running, new Promise((r) => setTimeout(r, 3000))]);
    await this.teardown();
    this.status.state = 'stopped';
    this.refreshPending();
    this.writeStatus();
    this.log('stopped');
  }

  private async teardown(): Promise<void> {
    this.stopping = true;
    await this.trigger?.stop().catch(() => {});
    await this.barrier?.stop().catch(() => {});
    await this.capturer?.close().catch(() => {});
  }

  private async startBarrier(): Promise<void> {
    const injected = this.opts.barrier;
    if (injected === null) {
      this.log('barrier disabled; using timeout only');
      return;
    }
    this.barrier =
      injected ??
      new ViteHmrClient({
        viteUrl: this.config.viteUrl,
        ignoreHTTPSErrors: this.config.ignoreHTTPSErrors,
        log: (m) => this.log(m),
      });
    this.barrier.on('state', () => this.writeStatus());
    this.barrier.start();
    // Give the websocket a moment so status reports the right barrier; it keeps connecting in the background.
    if (!(await this.barrier.waitForConnected(1500))) {
      this.log('hmr: not connected yet; barrier is timeout-only until it connects');
    }
    this.writeStatus();
  }

  // ---- batches -------------------------------------------------------------

  /** A relevant file changed: from now until its batch is fully handled, `finish` must not trust the timeline. */
  private onFileEvent(): void {
    if (this.stopping) return;
    this.status.lastEventAt = new Date().toISOString();
    this.debouncing = true;
    if (this.refreshPending()) this.writeStatus();
  }

  /** Recompute `pending` / `pendingSince` from the queue; true when `pending` flipped. */
  private refreshPending(): boolean {
    const pending = this.debouncing || this.pending !== null || this.running !== null;
    const flipped = pending !== this.status.pending;
    if (flipped) this.status.pendingSince = pending ? new Date().toISOString() : null;
    this.status.pending = pending;
    return flipped;
  }

  private enqueue(batch: WatchBatch): void {
    this.debouncing = false;
    if (this.stopping) {
      this.refreshPending();
      return;
    }
    this.merge({ screen: batch.screen, backend: batch.backend, startedAt: batch.startedAt, attempts: 0 });
    this.running ??= this.drain();
    this.refreshPending();
    this.writeStatus(); // carries the final lastEventAt of this change
  }

  private merge(part: { screen: Iterable<string>; backend: Iterable<string>; startedAt: number; attempts: number }): void {
    const pending = (this.pending ??= {
      screen: new Set(),
      backend: new Set(),
      startedAt: part.startedAt,
      attempts: part.attempts,
    });
    for (const f of part.screen) pending.screen.add(f);
    for (const f of part.backend) pending.backend.add(f);
    pending.startedAt = Math.min(pending.startedAt, part.startedAt);
    pending.attempts = Math.max(pending.attempts, part.attempts);
  }

  /** Single consumer: batches that arrive while one is being captured are merged and handled together. */
  private async drain(): Promise<void> {
    try {
      while (this.pending && !this.stopping) {
        const batch = this.pending;
        this.pending = null;
        await this.process(batch);
      }
    } finally {
      this.running = null;
      this.refreshPending();
      this.writeStatus();
    }
  }

  private async process(batch: Pending): Promise<void> {
    const screen = [...batch.screen].sort();
    const backend = [...batch.backend].sort();
    const done = (outcome: BatchEvent['outcome'], routes: string[] = []): void => {
      this.events.emit('batch', { screen, backend, routes, outcome } satisfies BatchEvent);
    };

    const marker = this.config.freshnessMarker;
    if (marker && !fs.existsSync(path.resolve(this.config.repoDir, marker))) {
      this.log(STALE_MESSAGE);
      this.status.lastError = STALE_MESSAGE; // so `finish` can say why there is no frame
      this.writeStatus();
      this.events.emit('refused', { reason: STALE_MESSAGE, marker, screen, backend });
      done('refused');
      return;
    }

    this.setState('capturing');
    const t0 = Date.now();
    const lap: Record<string, number> = {};
    const mark = (name: string): void => {
      lap[name] = Date.now() - t0;
    };
    try {
      const treeHash = this.opts.treeHash ?? workingTreeHash;
      // Read before the first hash: a file event anywhere between here and the second hash means the
      // pages may have rendered an intermediate state, even if the two hashes happen to be equal.
      const eventsBefore = this.trigger?.eventCount() ?? 0;
      const beforeP = treeHash(this.config.repoDir, this.dirs.scratchDir);
      beforeP.catch(() => {});

      const targets = new Map<string, Target>();
      if (screen.length > 0) {
        const [barrier, resolution] = await Promise.all([
          this.waitBarrier(batch.startedAt, screen),
          this.resolveScreen(screen),
        ]);
        mark('barrier+routes');
        this.log(`batch screen=${screen.join(',')} barrier=${barrier}`);
        for (const route of resolution) targets.set(route.path, route);
      }
      if (backend.length > 0) {
        if (screen.length === 0) this.log(`batch backend=${backend.join(',')}`);
        for (const [routePath, route] of this.sessionRoutes) {
          if (!targets.has(routePath)) {
            targets.set(routePath, { path: routePath, ...route, trigger: 'backend', sourceFile: backend[0] });
          }
        }
        if (this.sessionRoutes.size === 0) this.log('backend change: no routes captured this session yet');
      }

      if (targets.size === 0) {
        this.log('no routes to capture');
        done('no-routes');
        return;
      }

      const before = await beforeP;
      mark('resolve');
      const captured: Array<{ target: Target; at: string; png: Buffer; signals: CaptureSignals }> = [];
      let captureFailed = false;
      for (const target of targets.values()) {
        if (this.stopping) return;
        try {
          const result = await this.capturer!.capture(target.url);
          captured.push({ target, at: new Date().toISOString(), png: result.png, signals: result.signals });
        } catch (err) {
          captureFailed = true;
          this.fail(new Error(`capture ${target.path} failed: ${(err as Error).message}`));
        }
      }

      mark('captures');
      const after = await treeHash(this.config.repoDir, this.dirs.scratchDir);
      mark('hash');
      if (this.stopping) return;
      const eventsDuring = (this.trigger?.eventCount() ?? 0) - eventsBefore;
      if (after !== before || eventsDuring > 0) {
        const requeue = batch.attempts < (this.opts.maxRequeues ?? 2);
        const why =
          after !== before
            ? `working tree changed during capture (${before.slice(0, 8)} -> ${after.slice(0, 8)})`
            : `${eventsDuring} file event(s) arrived during capture (tree unchanged: ${after.slice(0, 8)})`;
        this.log(`discarded ${captured.length} frame(s): ${why}` + (requeue ? '; re-queued' : '; giving up after repeated changes'));
        this.events.emit('discarded', { routes: [...targets.keys()], before, after, requeued: requeue, events: eventsDuring });
        if (requeue) {
          // Not the old batch's startedAt: that would let a message from before this capture satisfy the next barrier.
          this.merge({ screen, backend, startedAt: Date.now(), attempts: batch.attempts + 1 });
        }
        done('discarded', [...targets.keys()]);
        return;
      }

      for (const { target, at, png, signals } of captured) {
        const verdict = triage(signals);
        const frame = this.timeline.append(
          {
            sessionId: this.sessionId,
            route: target.path,
            routeKey: target.routeKey,
            at,
            treeHash: after,
            trigger: target.trigger,
            sourceFile: target.sourceFile,
            status: verdict.status,
            reasons: verdict.reasons,
          },
          png,
        );
        this.sessionRoutes.set(target.path, { routeKey: target.routeKey, url: target.url });
        this.status.frames++;
        this.status.lastCaptureAt = at;
        this.log(
          `frame ${frame.id} ${frame.route} ${frame.status}${frame.reasons.length ? ` (${frame.reasons[0]})` : ''} tree=${after.slice(0, 8)}`,
        );
        this.events.emit('frame', { frame, signals, pngPath: this.timeline.pngPath(frame) } satisfies FrameEvent);
      }
      mark('write');
      if (!captureFailed && captured.length > 0) this.status.lastError = null; // the last problem is resolved
      this.log(`timing ${JSON.stringify(lap)} (ms since batch start; the debounce before it is not included)`);
      done('captured', [...targets.keys()]);
    } catch (err) {
      this.fail(err as Error);
      done('error');
    } finally {
      if (!this.stopping) this.setState('ready');
      if (this.graphStale && !this.stopping) this.refreshGraph();
    }
  }

  private async waitBarrier(startedAt: number, files: string[]): Promise<BarrierResult> {
    const timeout = this.opts.barrierTimeoutMs ?? 500;
    if (!this.barrier) {
      await new Promise((r) => setTimeout(r, timeout));
      return 'timeout';
    }
    // Credit a message that beat the fs debounce; 50 ms slack covers Vite noticing the save first.
    // Only a `full-reload` or an `update` naming one of these files counts: Vite's URL paths are
    // `/<repo-relative path>`, and an update for some other module says nothing about them.
    return this.barrier.waitForNextMessage(timeout, { since: startedAt - 50, files });
  }

  // ---- routes --------------------------------------------------------------

  private async resolveScreen(files: string[]): Promise<Target[]> {
    let graph = await this.getGraph();
    const touchesRoutes = files.some((f) => this.isRouteFile(f));
    const unknown = files.some((f) => !graph.fileToRoutes.has(f) && !this.config.staticRoutes[f]);
    if (touchesRoutes || unknown) {
      // The graph cannot be trusted for these files; pay for a rebuild now.
      this.graph = this.loadGraph();
      graph = await this.graph;
      this.graphStale = false;
    } else {
      // Imports may have changed; refresh after this batch so the next one sees them.
      this.graphStale = true;
    }

    const resolution = resolveRoutes(files, graph, this.config);
    for (const file of resolution.unmapped) this.log(`no route for ${file}`);
    for (const skip of resolution.skipped) this.log(`skipped route ${skip.routeKey}: ${skip.reason}`);
    return resolution.routes.map((r) => ({
      path: r.path,
      routeKey: r.routeKey,
      url: r.url,
      trigger: 'screen' as const,
      sourceFile: r.sourceFiles[0],
    }));
  }

  private getGraph(): Promise<ImportGraph> {
    this.graph ??= this.loadGraph();
    return this.graph;
  }

  private loadGraph(): Promise<ImportGraph> {
    const build = this.opts.buildGraph ?? ((config: Config) => buildImportGraph(config));
    const promise = build(this.config);
    promise.catch(() => {
      if (this.graph === promise) this.graph = null; // retry on next use
    });
    return promise;
  }

  private refreshGraph(): void {
    this.graphStale = false;
    this.graph = this.loadGraph();
    this.graph.catch(() => {});
  }

  private async logGraphSummary(): Promise<void> {
    try {
      const graph = await this.graph;
      if (graph) this.log(`import graph: ${graph.routes.length} route(s), ${graph.unresolved.length} unresolved note(s)`);
    } catch (err) {
      this.log(`import graph failed: ${(err as Error).message}`);
    }
  }

  // ---- status and logging --------------------------------------------------

  private setState(state: DaemonState): void {
    if (this.stopped && state !== 'stopped') return;
    this.status.state = state;
    this.writeStatus();
  }

  private fail(err: Error): void {
    this.status.lastError = err.message;
    this.log(`error: ${err.message}`);
    this.writeStatus();
    if (this.events.listenerCount('error') > 0) this.events.emit('error', err);
  }

  private writeStatus(): void {
    this.status.barrier = this.barrier?.state === 'connected' ? 'vite-hmr' : 'timeout-only';
    // `finish` records its outcome in this same file; keep it across the watcher's own rewrites.
    try {
      const existing = (JSON.parse(fs.readFileSync(this.files.status, 'utf8')) as Partial<Status>).lastFinish;
      if (existing !== undefined) this.status.lastFinish = existing;
    } catch {
      // No status file yet, or a torn one.
    }
    const tmp = `${this.files.status}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(this.status, null, 2)}\n`);
      fs.renameSync(tmp, this.files.status);
    } catch {
      // The status dir vanished (tests cleaning up); nothing useful to do.
    }
  }

  private log(message: string): void {
    const line = `${new Date().toISOString()} ${message}`;
    try {
      fs.appendFileSync(this.files.log, `${line}\n`);
    } catch {
      // See writeStatus.
    }
    this.opts.log?.(line);
  }
}
