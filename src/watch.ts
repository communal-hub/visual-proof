import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { Browser, type Capturer, type CaptureSignals, type CaptureTiming, type ScenarioPlan } from './browser.js';
import type { Config } from './config.js';
import { resolveAnchor } from './anchor.js';
import { headCommit, workingTreeHash } from './git.js';
import { ensureDirs, resolveDirs, statusFiles, type Dirs } from './paths.js';
import { buildImportGraph, type ImportGraph } from './resolve/import-graph.js';
import { ParamSourceResolver, type SourceOutcome } from './resolve/param-sources.js';
import { loadRouteParams } from './resolve/route-params.js';
import { concretePath, joinUrl, resolveRoutes } from './resolve/routes.js';
import {
  findSidecarFiles,
  formatSidecarError,
  loadSidecar,
  scenarioRouteKeys,
  sidecarRoute,
  validateSidecar,
  type Sidecar,
} from './sidecar.js';
import { Timeline, type Frame, type FrameStep, type Trigger } from './timeline.js';
import { startFsWatch, type FsWatchHandle, type WatchBatch } from './trigger/fs-watch.js';
import { ViteHmrClient, type BarrierResult, type HmrState } from './trigger/vite-hmr.js';
import { type DaemonState, type Status, type WarmupRouteStatus } from './status.js';
import { triage } from './triage.js';
// A4 decisions hooks (v0.6): everything else lives in src/decisions/**.
import { type DecisionsApi } from './decisions/client.js';
import { DecisionRuntime } from './decisions/runtime.js';
import { writeTextSidecar } from './decisions/sidecar.js';
import { pruneForWatch } from './decisions/watch.js';

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
  /** Replaces the OpenRouter Decisions client (tests). */
  decisionsClient?: DecisionsApi;
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
  /** Sidecar files that changed in this batch (scenarios replayed for other reasons are only in `routes`). */
  sidecar: string[];
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
  sidecar: Set<string>;
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

/** A sidecar scenario chosen to run in a batch. */
interface ScenarioJob {
  sidecar: Sidecar;
  plan: ScenarioPlan;
  trigger: Trigger;
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
  /** Route params from list endpoints (the third tier); fetches through the capturer's logged-in context. */
  private readonly paramSources: ParamSourceResolver;
  /** A4 decisions: route pruning for high fan-out files (cached in the status dir; `finish` reads the same cache). */
  private readonly decisions: DecisionRuntime;

  private capturer: Capturer | null = null;
  private barrier: BarrierSource | null = null;
  private trigger: FsWatchHandle | null = null;

  private pending: Pending | null = null;
  /** True from the first file event of a change until its batch is handed to {@link enqueue}. */
  private debouncing = false;
  /** True while the warm-up visits routes; batches queue up but are not captured until it is over. */
  private warmingUp = false;
  private running: Promise<void> | null = null;
  private stopping = false;
  private stopped: Promise<void> | null = null;

  private graph: Promise<ImportGraph> | null = null;
  private graphStale = false;
  /** The route-params problems last logged, so an unchanged bad file does not log on every batch. */
  private lastParamsProblems = '';
  /** Concrete path -> route, for every route that produced a frame this session. */
  private readonly sessionRoutes = new Map<string, { routeKey: string; url: string }>();
  /** Sidecar files that produced frames this session; a backend (or unmapped) change replays them. */
  private readonly sidecarsRun = new Set<string>();
  /** The sidecar problems last logged, so an unchanged bad file does not log on every batch. */
  private readonly sidecarProblems = new Map<string, string>();

  constructor(
    private readonly config: Config,
    private readonly opts: WatchOptions,
  ) {
    this.dirs = opts.dirs ?? resolveDirs(opts.env);
    this.files = statusFiles(this.dirs);
    this.sessionId = opts.sessionId ?? `s-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    this.timeline = new Timeline(this.dirs.scratchDir, config.maxFrames);
    this.isRouteFile = picomatch(config.routeFiles, { dot: true });
    this.decisions = new DecisionRuntime({
      config: config.decisions,
      env: opts.env ?? process.env,
      configDir: config.repoDir,
      client: opts.decisionsClient,
      log: (m) => this.log(m),
    });
    this.paramSources = new ParamSourceResolver(config.paramSources, async (urlPath) => {
      if (!this.capturer?.getJson) throw new Error('this capturer cannot fetch JSON');
      return this.capturer.getJson(urlPath);
    });
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
      await this.resolveAnchor();

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
        sidecarGlobs: this.config.sidecars,
        ignorePaths: [this.dirs.statusDir, this.dirs.scratchDir, this.dirs.artifactDir],
        debounceMs: this.opts.debounceMs,
        onEvent: () => this.onFileEvent(),
        onBatch: (batch) => this.enqueue(batch),
        onError: (err) => this.fail(err),
      });

      await this.warmUp().catch((err: Error) => {
        // Never fatal: the watcher works without a warm Vite, only its first capture is slower.
        this.log(`warmup: failed: ${err.message.split('\n')[0]}`);
        this.status.warmup = { state: 'failed', routes: this.status.warmup?.routes ?? [] };
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
    this.endWarmup();
  }

  private async resolveAnchor(): Promise<void> {
    const result = await resolveAnchor({
      repoDir: this.config.repoDir,
      statusDir: this.dirs.statusDir,
      headCommit: this.opts.headCommit ?? headCommit,
    });
    this.status.anchor = result.anchor;
    if (result.discarded) this.log(`anchor: ${result.discarded}`);
    if (result.anchor) {
      const how = result.source === 'reused' ? 'reused from an earlier session of this branch' : result.source === 'new' ? 'HEAD' : 'HEAD, not persisted';
      this.log(`anchor ${result.anchor.slice(0, 8)} (${how})`);
    }
  }

  // ---- warm-up -------------------------------------------------------------

  /**
   * Visit a few routes so Vite compiles them and optimizes dependencies before the first real capture
   * (a cold dev server spends seconds on this and reloads the page while it does). Bounded by
   * `warmupBudgetMs`; any failure is logged and startup carries on. File events that arrive meanwhile are
   * queued and handled once the watcher is ready.
   */
  private async warmUp(): Promise<void> {
    const capturer = this.capturer;
    if (!capturer?.prime) {
      this.log('warmup: skipped (the capturer cannot prime pages)');
      this.status.warmup = { state: 'skipped', routes: [] };
      return;
    }
    const targets = await this.warmupTargets();
    if (targets.length === 0) {
      this.log('warmup: skipped (no routes to visit)');
      this.status.warmup = { state: 'skipped', routes: [] };
      return;
    }

    this.warmingUp = true;
    const routes: WarmupRouteStatus[] = [];
    this.status.warmup = { state: 'running', routes };
    this.writeStatus();
    const budget = this.config.warmupBudgetMs;
    const t0 = Date.now();
    this.log(`warmup: visiting ${targets.map((t) => t.path).join(', ')} (budget ${budget} ms)`);
    let timedOut = false;
    for (const target of targets) {
      const left = budget - (Date.now() - t0);
      if (left <= 0 || this.stopping) {
        timedOut = left <= 0;
        break;
      }
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        const outcome = await Promise.race([
          capturer.prime(target.url),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), left);
          }),
        ]);
        const ms = Date.now() - started;
        if (outcome === 'timeout') {
          timedOut = true;
          routes.push({ route: target.path, ms, ok: false, error: `not finished within the ${budget} ms budget` });
          this.log(`warmup: ${target.path} did not finish within the budget`);
          break;
        }
        const ok = outcome.navOk && (outcome.httpStatus === null || outcome.httpStatus < 500);
        routes.push({ route: target.path, ms, ok, reloads: outcome.reloads, ...(ok ? {} : { error: `HTTP ${outcome.httpStatus ?? 'n/a'}` }) });
        this.log(
          `warmup: ${target.path} ${ok ? 'ok' : 'failed'} in ${ms} ms` +
            (outcome.reloads > 0 ? ` (${outcome.reloads} reload(s) from Vite, ${outcome.passes} passes)` : ''),
        );
      } catch (err) {
        const message = (err as Error).message.split('\n')[0] ?? 'unknown error';
        routes.push({ route: target.path, ms: Date.now() - started, ok: false, error: message });
        this.log(`warmup: ${target.path} failed: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    const ms = Date.now() - t0;
    const state = timedOut ? 'timeout' : routes.some((r) => r.ok) ? 'done' : 'failed';
    this.status.warmup = { state, ms, routes };
    this.log(`warmup: ${state} in ${ms} ms (${routes.map((r) => `${r.route} ${r.ms} ms`).join(', ')})`);
    this.writeStatus();
  }

  /** Release batches that were held back while warming up. Called once `ready` is reported. */
  private endWarmup(): void {
    if (!this.warmingUp) return;
    this.warmingUp = false;
    if (this.pending && !this.running && !this.stopping) this.running = this.drain();
    this.refreshPending();
  }

  private async warmupTargets(): Promise<Array<{ path: string; url: string }>> {
    const params = this.readRouteParams();
    const paths: string[] = [];
    const add = async (key: string): Promise<void> => {
      const concrete = concretePath(key, params);
      let path: string | null = concrete.ok ? concrete.path : null;
      let reason = concrete.ok ? '' : concrete.reason;
      if (!concrete.ok && this.paramSources.has(key)) {
        const outcome = await this.fromSource(key);
        if (outcome.ok) path = outcome.path;
        else reason = outcome.reason;
      }
      if (path === null) {
        this.log(`warmup: skipped ${key}: ${reason}`);
      } else if (!paths.includes(path)) {
        paths.push(path);
      }
    };

    const configured = this.config.warmupRoutes;
    if (configured !== undefined) {
      for (const key of configured) await add(key);
    } else {
      try {
        const graph = await this.getGraph();
        for (const route of graph.routes) {
          if (concretePath(route.path, params).ok) {
            await add(route.path);
            break;
          }
        }
      } catch (err) {
        this.log(`warmup: import graph unavailable: ${(err as Error).message.split('\n')[0]}`);
      }
      if (paths.length === 0) paths.push('/');
    }
    return paths.map((p) => ({ path: p, url: joinUrl(this.config.appUrl, p) }));
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
    this.merge({ screen: batch.screen, backend: batch.backend, sidecar: batch.sidecar ?? [], startedAt: batch.startedAt, attempts: 0 });
    if (!this.warmingUp) this.running ??= this.drain();
    this.refreshPending();
    this.writeStatus(); // carries the final lastEventAt of this change
  }

  private merge(part: {
    screen: Iterable<string>;
    backend: Iterable<string>;
    sidecar: Iterable<string>;
    startedAt: number;
    attempts: number;
  }): void {
    const pending = (this.pending ??= {
      screen: new Set(),
      backend: new Set(),
      sidecar: new Set(),
      startedAt: part.startedAt,
      attempts: part.attempts,
    });
    for (const f of part.screen) pending.screen.add(f);
    for (const f of part.backend) pending.backend.add(f);
    for (const f of part.sidecar) pending.sidecar.add(f);
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
    const sidecar = [...batch.sidecar].sort();
    const done = (outcome: BatchEvent['outcome'], routes: string[] = []): void => {
      this.events.emit('batch', { screen, backend, sidecar, routes, outcome } satisfies BatchEvent);
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

      const params = this.readRouteParams();
      const targets = new Map<string, Target>();
      // Routes captured earlier this session are re-captured when the change cannot be traced to a route.
      let recapture: { trigger: Trigger; why: string; sourceFile: string } | null = null;
      // The data behind the list endpoints may have changed (a re-seed): look the ids up again.
      if (backend.length > 0) this.paramSources.invalidate();
      if (screen.length > 0) {
        const [barrier, resolution] = await Promise.all([
          this.waitBarrier(batch.startedAt, screen),
          this.resolveScreen(screen, params),
        ]);
        mark('barrier+routes');
        this.log(`batch screen=${screen.join(',')} barrier=${barrier}`);
        for (const route of resolution.targets) targets.set(route.path, route);
        if (resolution.unmapped.length > 0) {
          // The file feeds routes the graph cannot see (a layout imported dynamically, a shared helper):
          // keep every frame of the session at HEAD, as for a backend change.
          recapture = { trigger: 'screen', why: `no route for ${resolution.unmapped.join(',')}`, sourceFile: resolution.unmapped[0]! };
        }
      }
      if (backend.length > 0) {
        if (screen.length === 0) this.log(`batch backend=${backend.join(',')}`);
        recapture = { trigger: 'backend', why: 'backend change', sourceFile: backend[0]! };
      }
      if (recapture) {
        for (const [capturedPath, route] of this.sessionRoutes) {
          // Re-resolve: a re-run seeder may have moved a param route to a new id since it was captured.
          const concrete = concretePath(route.routeKey, params);
          let routePath = concrete.ok ? concrete.path : capturedPath;
          let url = concrete.ok ? joinUrl(this.config.appUrl, routePath) : route.url;
          if (!concrete.ok && this.paramSources.has(route.routeKey)) {
            const outcome = await this.fromSource(route.routeKey);
            if (!outcome.ok) {
              this.log(`skipped route ${route.routeKey}: ${outcome.reason}`);
              continue;
            }
            routePath = outcome.path;
            url = joinUrl(this.config.appUrl, routePath);
          }
          if (!targets.has(routePath)) {
            targets.set(routePath, { path: routePath, routeKey: route.routeKey, url, trigger: recapture.trigger, sourceFile: recapture.sourceFile });
          }
        }
        if (this.sessionRoutes.size === 0) this.log(`${recapture.why}: no routes captured this session yet`);
        else if (recapture.trigger === 'screen') this.log(`${recapture.why}: re-capturing ${this.sessionRoutes.size} route(s) captured this session`);
      }

      const scenarios = await this.pickScenarios({ changed: sidecar, screen, recapture: recapture?.trigger ?? null, params });

      if (targets.size === 0 && scenarios.length === 0) {
        this.log('no routes to capture');
        await beforeP.catch(() => {}); // the tree hash writes into the scratch dir; do not leave git running behind a finished batch
        done('no-routes');
        return;
      }

      const before = await beforeP;
      mark('resolve');
      const captured: Array<{
        target: Target;
        at: string;
        png: Buffer;
        signals: CaptureSignals;
        renderedFiles: string[] | null;
        timing?: CaptureTiming;
        pageText?: string;
        /** Sidecar stills only. */
        steps?: FrameStep[];
      }> = [];
      let captureFailed = false;
      for (const target of targets.values()) {
        if (this.stopping) return;
        try {
          const result = await this.capturer!.capture(target.url);
          captured.push({ target, at: new Date().toISOString(), png: result.png, signals: result.signals, renderedFiles: result.renderedFiles ?? null, timing: result.timing, pageText: result.pageText });
        } catch (err) {
          captureFailed = true;
          this.fail(new Error(`capture ${target.path} failed: ${(err as Error).message}`));
        }
      }

      const ranScenarios: string[] = [];
      for (const job of scenarios) {
        if (this.stopping) return;
        const file = job.sidecar.file;
        if (!this.capturer!.runScenario) {
          this.log(`sidecar ${file} skipped: this capturer cannot run scenarios`);
          continue;
        }
        try {
          const result = await this.capturer!.runScenario(job.plan);
          for (const still of result.stills) {
            const route = sidecarRoute(file, still.name);
            captured.push({
              target: { path: route, routeKey: route, url: '', trigger: job.trigger, sourceFile: file },
              at: still.at,
              png: still.png,
              signals: still.signals,
              renderedFiles: still.renderedFiles,
              timing: still.timing,
              pageText: still.pageText,
              steps: still.steps,
            });
          }
          ranScenarios.push(file);
          this.log(
            `sidecar ${file}: ${result.stills.filter((x) => !x.failed).length} still(s) in ${result.ms} ms` +
              (result.failure ? `; failed at line ${result.failure.line} ${result.failure.text}: ${result.failure.reason}` : ''),
          );
        } catch (err) {
          captureFailed = true;
          this.fail(new Error(`sidecar ${file} failed: ${(err as Error).message}`));
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
        const routes = [...targets.keys(), ...captured.filter((c) => c.steps).map((c) => c.target.path)];
        this.events.emit('discarded', { routes, before, after, requeued: requeue, events: eventsDuring });
        if (requeue) {
          // Not the old batch's startedAt: that would let a message from before this capture satisfy the next barrier.
          this.merge({ screen, backend, sidecar, startedAt: Date.now(), attempts: batch.attempts + 1 });
        }
        done('discarded', routes);
        return;
      }

      for (const { target, at, png, signals, renderedFiles, timing, pageText, steps } of captured) {
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
            renderedFiles,
            ...(timing ? { timing } : {}),
            ...(steps ? { steps } : {}),
          },
          png,
        );
        // A4: the page text for the claim check lives next to the PNG, not in index.jsonl.
        if (pageText !== undefined && this.config.decisions.verdict && this.config.decisions.enabled !== false) {
          writeTextSidecar(this.timeline.pngPath(frame), pageText);
        }
        if (!steps) this.sessionRoutes.set(target.path, { routeKey: target.routeKey, url: target.url });
        this.status.frames++;
        this.status.lastCaptureAt = at;
        this.log(
          `frame ${frame.id} ${frame.route} ${frame.status}${frame.reasons.length ? ` (${frame.reasons[0]})` : ''} tree=${after.slice(0, 8)}`,
        );
        this.events.emit('frame', { frame, signals, pngPath: this.timeline.pngPath(frame) } satisfies FrameEvent);
      }
      for (const file of ranScenarios) this.sidecarsRun.add(file);
      mark('write');
      if (!captureFailed && captured.length > 0) this.status.lastError = null; // the last problem is resolved
      this.log(`timing ${JSON.stringify(lap)} (ms since batch start; the debounce before it is not included)`);
      done('captured', [...targets.keys(), ...captured.filter((c) => c.steps).map((c) => c.target.path)]);
    } catch (err) {
      this.fail(err as Error);
      done('error');
    } finally {
      if (!this.stopping) this.setState('ready');
      if (this.graphStale && !this.stopping) this.refreshGraph();
    }
  }

  // ---- sidecars ------------------------------------------------------------

  /**
   * The scenarios to replay for this batch: the sidecar files that changed; those with a `goto` on a route that a
   * changed screen file renders (through the import graph); and, when the batch re-captures routes (a backend
   * change, or a screen file with no route), every scenario that has run this session. A scenario that does not
   * parse is logged and skipped: `finish` reports it.
   */
  private async pickScenarios(batch: {
    changed: string[];
    screen: string[];
    recapture: Trigger | null;
    params: Record<string, string>;
  }): Promise<ScenarioJob[]> {
    if (this.config.sidecars.length === 0) return [];
    const existing = new Set(findSidecarFiles(this.config.repoDir, this.config.sidecars));
    for (const file of [...this.sidecarsRun]) if (!existing.has(file)) this.sidecarsRun.delete(file);
    for (const file of this.sidecarProblems.keys()) if (!existing.has(file)) this.sidecarProblems.delete(file);
    if (existing.size === 0) return [];

    const reasons = new Map<string, Trigger>();
    for (const file of batch.changed) if (existing.has(file)) reasons.set(file, 'sidecar');
    if (batch.recapture) {
      for (const file of this.sidecarsRun) if (!reasons.has(file)) reasons.set(file, batch.recapture);
    }

    const loaded = new Map<string, Sidecar>();
    const load = (file: string): Sidecar => {
      let sidecar = loaded.get(file);
      if (!sidecar) loaded.set(file, (sidecar = loadSidecar(this.config.repoDir, file)));
      return sidecar;
    };

    if (batch.screen.length > 0) {
      try {
        const graph = await this.getGraph();
        const knownKeys = new Set([...graph.routes.map((r) => r.path), ...Object.values(this.config.staticRoutes).flat()]);
        const touched = new Set<string>();
        for (const file of batch.screen) for (const key of graph.fileToRoutes.get(file) ?? this.config.staticRoutes[file] ?? []) touched.add(key);
        if (touched.size > 0) {
          for (const file of existing) {
            if (reasons.has(file)) continue;
            const sidecar = load(file);
            if (scenarioRouteKeys(sidecar, knownKeys).some((key) => touched.has(key))) reasons.set(file, 'screen');
          }
        }
      } catch (err) {
        this.log(`sidecars: import graph unavailable: ${(err as Error).message.split('\n')[0]}`);
      }
    }

    const jobs: ScenarioJob[] = [];
    for (const [file, trigger] of [...reasons].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const sidecar = load(file);
      const errors = validateSidecar(sidecar, this.config);
      const problems = errors.map((e) => formatSidecarError(file, e)).join('\n');
      if (errors.length > 0) {
        if (this.sidecarProblems.get(file) !== problems) {
          this.sidecarProblems.set(file, problems);
          for (const line of problems.split('\n')) this.log(`warning: sidecar ${line}`);
        }
        this.log(`sidecar ${file} skipped: ${errors.length} parse error(s)`);
        continue;
      }
      this.sidecarProblems.delete(file);
      const gotos = new Map<number, { url: string; path: string } | { error: string }>();
      for (const step of sidecar.steps) {
        if (step.verb === 'goto') gotos.set(step.line, await this.resolveGoto(step.target, batch.params));
      }
      jobs.push({ sidecar, trigger, plan: { file, name: sidecar.name, steps: sidecar.steps, gotos } });
    }
    if (jobs.length > 0) this.log(`sidecars: ${jobs.map((j) => `${j.sidecar.file} (${j.trigger})`).join(', ')}`);
    return jobs;
  }

  /** A `goto` target is a concrete path, or a route key filled through routeParams, the seed file, then paramSources. */
  private async resolveGoto(target: string, params: Record<string, string>): Promise<{ url: string; path: string } | { error: string }> {
    const concrete = concretePath(target, params);
    if (concrete.ok) return { path: concrete.path, url: joinUrl(this.config.appUrl, concrete.path) };
    if (this.paramSources.has(target)) {
      const outcome = await this.fromSource(target);
      if (outcome.ok) return { path: outcome.path, url: joinUrl(this.config.appUrl, outcome.path) };
      return { error: `cannot fill ${target}: ${outcome.reason}` };
    }
    return { error: `cannot fill ${target}: ${concrete.reason}` };
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

  /** Config `routeParams` plus the seed file, re-read per batch. Problems are logged once per distinct message. */
  private readRouteParams(): Record<string, string> {
    const result = loadRouteParams(this.config);
    const problems = [...(result.error ? [result.error] : []), ...result.warnings];
    const key = problems.join('\n');
    if (key !== this.lastParamsProblems) {
      this.lastParamsProblems = key;
      for (const problem of problems) this.log(`warning: ${problem}`);
    }
    return result.params;
  }

  private async resolveScreen(
    files: string[],
    params: Record<string, string>,
  ): Promise<{ targets: Target[]; unmapped: string[] }> {
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

    // A4 hook: a file that fans out to many routes is pruned to the likely ones (decision cached for `finish`).
    const resolution = await pruneForWatch(
      this.config,
      this.decisions,
      this.dirs.statusDir,
      files,
      resolveRoutes(files, graph, { ...this.config, routeParams: params }),
      graph,
      this.status.anchor,
    );
    for (const file of resolution.unmapped) this.log(`no route for ${file}`);
    for (const skip of resolution.skipped) this.log(`skipped route ${skip.routeKey}: ${skip.reason}`);
    const targets: Target[] = resolution.routes.map((r) => ({
      path: r.path,
      routeKey: r.routeKey,
      url: r.url,
      trigger: 'screen' as const,
      sourceFile: r.sourceFiles[0],
    }));
    for (const skip of resolution.skipped) {
      if (!this.paramSources.has(skip.routeKey)) {
        this.log(`skipped route ${skip.routeKey}: ${skip.reason}`);
        continue;
      }
      // Neither routeParams nor the seed file has it: ask the list endpoint.
      const outcome = await this.fromSource(skip.routeKey);
      if (!outcome.ok) {
        this.log(`skipped route ${skip.routeKey}: ${outcome.reason}`);
        continue;
      }
      targets.push({
        path: outcome.path,
        routeKey: skip.routeKey,
        url: joinUrl(this.config.appUrl, outcome.path),
        trigger: 'screen',
        sourceFile: skip.sourceFiles[0],
      });
    }
    return { targets, unmapped: resolution.unmapped };
  }

  /** Fill a route key from its `paramSources` entry and record the outcome in `status.json` for `finish`. */
  private async fromSource(routeKey: string): Promise<SourceOutcome> {
    const outcome = await this.paramSources.resolve(routeKey);
    const sources = (this.status.paramSources ??= {});
    const before = sources[routeKey];
    if (outcome.ok) {
      if (before?.path !== outcome.path || before.error !== undefined) {
        this.log(`param source ${this.config.paramSources[routeKey]!.url}: ${routeKey} -> ${outcome.path}`);
      }
      sources[routeKey] = { path: outcome.path, at: new Date().toISOString() };
    } else {
      if (before?.error !== outcome.reason) this.log(`warning: ${outcome.reason} (route ${routeKey})`);
      sources[routeKey] = { ...(before?.path !== undefined ? { path: before.path } : {}), error: outcome.reason, at: new Date().toISOString() };
    }
    this.writeStatus();
    return outcome;
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
