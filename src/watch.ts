import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { Browser, type Capturer, type CaptureSignals, type CaptureTiming, type ScenarioPlan } from './browser.js';
import type { Config } from './config.js';
import { resolveAnchor } from './anchor.js';
import { headCommit, treeBlobs, treeDiff, workingTreeHash } from './git.js';
import { staleCheck, type FrameDependencies } from './carry.js';
import { readClaimRequest, screenReady, type ClaimScreenState, type ClaimScreenStatus, type ClaimStatus } from './claim-status.js';
import { classifier } from './globs.js';
import { ensureDirs, resolveDirs, statusFiles, type Dirs } from './paths.js';
import { buildImportGraph, type ImportGraph } from './resolve/import-graph.js';
import { ParamSourceResolver, type SourceOutcome } from './resolve/param-sources.js';
import { concretePath, joinUrl, resolveRoutes } from './resolve/routes.js';
import {
  FAILED_STILL,
  findSidecarFiles,
  formatSidecarError,
  gotoRouteKeys,
  loadSidecar,
  scenarioRouteKeys,
  sidecarRoute,
  validateSidecar,
  type Sidecar,
} from './sidecar.js';
import { Timeline, type Frame, type FrameStep, type ParamsFrom, type Trigger } from './timeline.js';
import { startFsWatch, type FsWatchHandle, type WatchBatch } from './trigger/fs-watch.js';
import { ViteHmrClient, type BarrierResult, type HmrState } from './trigger/vite-hmr.js';
import { type DaemonState, type Status, type WarmupRouteStatus } from './status.js';
import { triage } from './triage.js';
import { probeFfmpeg } from './replay.js';
// A4 decisions hooks (v0.6): everything else lives in src/decisions/**.
import { type DecisionsApi } from './decisions/client.js';
import { DecisionRuntime } from './decisions/runtime.js';
import { writeTextSidecar } from './decisions/sidecar.js';
import { pruneForWatch } from './decisions/watch.js';
import { claimPath, readClaim } from './decisions/claim.js';
import { directlyTouches } from './decisions/prune.js';
import { normalizeScreen, parseExpectations, screenLabels } from './focus.js';
// v0.8 dynamic params hooks: the tiers, discovery and the session file live in src/resolve/param-*.ts and session-*.ts.
import { ParamDiscoverer, writeDiscoveryCache, type DiscoveryOutcome } from './resolve/param-discovery.js';
import { ParamFiller, type FillOutcome } from './resolve/param-fill.js';
import { loadLayeredParams, type LayeredParams } from './resolve/param-tiers.js';
import { hasParams } from './resolve/route-pattern.js';
import { changedSessionRoutes, readSessionParams, type SessionEntry } from './resolve/session-params.js';
import { watchFile, watchSessionParams, type SessionWatchHandle } from './resolve/session-watch.js';

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
  /** v0.8: replaces the watcher on `session-params.json` (tests). */
  watchSession?: typeof watchSessionParams;
  /** v0.12: replaces the watcher on the claim file (tests). */
  watchClaim?: typeof watchFile;
  /** v0.13: replaces the watcher on `claim-request.json` (tests). */
  watchClaimRequest?: typeof watchFile;
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
  /** v0.8: route keys whose session params were just set (`visual-proof params set`). */
  params: Set<string>;
  /** v0.8: the session file revision the `params` come from; acknowledged in `status.json` when handled. */
  paramsRev?: number;
  /** v0.12: the claim names screens it did not before; capture those without a clean frame at the current tree. */
  claim: boolean;
  /** v0.12: targets whose frames a change during their capture made stale, to capture again (by concrete path). */
  retry: Map<string, Target>;
  /** v0.12: sidecar files whose run a change during it made stale, with the trigger the run had. */
  retrySidecars: Map<string, Trigger>;
  /** v0.12: changed screen files behind a retry; the retry waits on the HMR barrier for them. */
  retryWait: Set<string>;
  /** v0.13: the `claim-request.json` rev this batch answers; acknowledged in `claim.request` once the claim screens are checked. */
  requestRev?: number;
  startedAt: number;
  attempts: number;
}

interface Target {
  path: string;
  routeKey: string;
  url: string;
  trigger: Trigger;
  sourceFile?: string;
  /** v0.8 provenance: which tier filled the route's params, and for `discovered` the page that had the link. */
  paramsFrom?: ParamsFrom;
  foundOn?: string;
  discoveryMs?: number;
  /** v0.13: where the capture goes in the batch; a re-queued target keeps it. */
  tier?: Tier;
}

/** Where a capture goes in a batch (v0.13): claim screens first, then the other headlines, then impact routes. */
type Tier = 'claim' | 'headline' | 'impact';

/** One capture of a batch: a route, or a sidecar scenario run. */
type Job = { tier: Tier; route: Target } | { tier: Tier; scenario: ScenarioJob };

function jobKey(job: Job): string {
  return 'route' in job ? job.route.path : `sidecar:${job.scenario.sidecar.file}`;
}

function isImpactRoute(job: Job): boolean {
  return job.tier === 'impact' && 'route' in job;
}

/** Run `fn` over `items`, `size` at a time, starting no new item once `halt` says so; returns the items not started. */
async function runPool<T>(items: T[], size: number, fn: (item: T) => Promise<void>, halt: () => boolean): Promise<T[]> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !halt()) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return items.slice(next);
}

/** What one round of a batch came to; `unknown` when the frames could not be checked against a change during it. */
type RoundOutcome =
  | { unknown: string; routes: string[] }
  | { after: string; eventsAfter: number; kept: string[]; dropped: string[]; captureFailed: boolean; requeued: boolean; preempted: boolean };

/** A sidecar scenario chosen to run in a batch. */
interface ScenarioJob {
  sidecar: Sidecar;
  plan: ScenarioPlan;
  trigger: Trigger;
}

/** One capture of a batch, before it is recorded. */
interface Captured {
  target: Target;
  at: string;
  png: Buffer;
  signals: CaptureSignals;
  renderedFiles: string[] | null;
  timing?: CaptureTiming;
  pageText?: string;
  /** Sidecar stills only. */
  steps?: FrameStep[];
  /** Sidecar stills of a recorded run (v0.9). */
  clip?: string;
  /** Sidecar stills only: the run they came from. */
  job?: ScenarioJob;
}

const STALE_MESSAGE = 'stale: freshness marker missing, capture refused';

/** A claim request this recent when the watcher starts was made for it (while it was starting). */
const RECENT_REQUEST_MS = 120_000;

/** Worst first when several sidecar stills stand for one claim screen. */
const STATE_RANK: Record<ClaimScreenState, number> = { clean: 0, carried: 1, unmatched: 2, queued: 3, missing: 4, 'not-clean': 5, unfilled: 6 };

function frameNumber(id: string): number {
  const n = Number(id.slice(2));
  return Number.isFinite(n) ? n : 0;
}

/** Which tier filled a route's params (v0.8); empty for a route without params. */
interface Provenance {
  paramsFrom?: ParamsFrom;
  foundOn?: string;
  discoveryMs?: number;
}

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
  // v0.8 dynamic params
  /** Fills a route's params from the tiers beyond the cheap ones; created in `start()` once the capturer is known. */
  private filler: ParamFiller | null = null;
  private discoverer: ParamDiscoverer | null = null;
  /** Which of session/config/file each key in the last-read params came from. */
  private paramOrigin: LayeredParams['origin'] = {};
  /** The session entries last seen, to tell which ones a change of the file is about. */
  private sessionSeen: Record<string, SessionEntry> = {};
  private sessionWatch: SessionWatchHandle | null = null;
  // v0.12 claim
  private claimWatch: SessionWatchHandle | null = null;
  /** The claim screens last seen (normalized), to tell when the claim names a new one. */
  private claimSeen = new Set<string>();
  /** Whether "no claim screens yet" was logged since the claim last named one. */
  private noClaimNoted = false;
  // v0.13 claim readiness
  private requestWatch: SessionWatchHandle | null = null;
  /** Highest claim request merged into a batch, so a rewrite of the same request is not queued twice. */
  private requestSeen = 0;
  /** Work queued from outside the running batch (a save, params, the claim, a claim request): it preempts impact captures. */
  private newWork = false;
  /** Routes (by path) and sidecars (`sidecar:<file>`) of the running batch not captured yet. */
  private jobsLeft = new Set<string>();
  /** The last tree hashed and the event count read before it, for refreshing the claim status between batches. */
  private lastTree: { tree: string; events: number } | null = null;
  /** Files whose events were dropped for an unchanged content, logged together. */
  private unchangedFiles = new Set<string>();
  private unchangedTimer: NodeJS.Timeout | null = null;
  /** Bumped by every claim-status refresh; a slower, older one must not overwrite a newer answer. */
  private claimSeq = 0;

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
  private readonly sessionRoutes = new Map<string, { routeKey: string; url: string; paramsFrom?: ParamsFrom; foundOn?: string }>();
  /** Sidecar files that produced frames this session; a backend (or unmapped) change replays them. */
  private readonly sidecarsRun = new Set<string>();
  /** The sidecar problems last logged, so an unchanged bad file does not log on every batch. */
  private readonly sidecarProblems = new Map<string, string>();
  /** v0.9: whether scenarios are recorded as motion clips (replay.motion on and an ffmpeg that can encode them). */
  private motion: Promise<boolean> | null = null;

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
      repoDir: config.repoDir,
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
      const startTree = await treeHash(this.config.repoDir, this.dirs.scratchDir); // fail fast outside a git repo
      this.lastTree = { tree: startTree, events: 0 };
      await this.resolveAnchor();

      await this.startBarrier();

      this.capturer =
        this.opts.capturer ??
        (await Browser.launch(this.config, { log: (m) => this.log(`browser: ${m}`) }));
      await this.capturer.warm();
      this.setupParamFiller();

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
        // v0.13: what every file held at start, so a save that writes the same bytes is not a change.
        baseline: await treeBlobs(this.config.repoDir, startTree).catch(() => new Map<string, string>()),
        onUnchanged: (file) => this.onUnchanged(file),
        onEvent: () => this.onFileEvent(),
        onBatch: (batch) => this.enqueue(batch),
        onError: (err) => this.fail(err),
      });

      await this.startSessionWatch();
      await this.startClaimWatch();
      await this.startRequestWatch();

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
    this.onClaimRequest(); // one made while starting
    void this.refreshClaimIdle();
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
    await this.sessionWatch?.stop().catch(() => {});
    await this.claimWatch?.stop().catch(() => {});
    await this.requestWatch?.stop().catch(() => {});
    if (this.unchangedTimer) clearTimeout(this.unchangedTimer);
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
    const claimWasCurrent = this.status.claim?.current === true;
    if (this.status.claim) this.status.claim.current = false; // the claim screens must be looked at again
    if (this.refreshPending() || claimWasCurrent) this.writeStatus();
  }

  /** A save that left the file as it was: logged (a burst together), never captured. */
  private onUnchanged(file: string): void {
    if (this.stopping) return;
    this.unchangedFiles.add(file);
    this.unchangedTimer ??= setTimeout(() => {
      this.unchangedTimer = null;
      const files = [...this.unchangedFiles].sort();
      this.unchangedFiles.clear();
      const listed = files.length > 5 ? `${files.slice(0, 5).join(', ')} and ${files.length - 5} more` : files.join(', ');
      this.log(`ignored: ${listed} written with the same content (nothing to capture)`);
    }, 500);
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
    this.newWork = true;
    this.merge({ screen: batch.screen, backend: batch.backend, sidecar: batch.sidecar ?? [], startedAt: batch.startedAt, attempts: 0 });
    if (!this.warmingUp) this.running ??= this.drain();
    this.refreshPending();
    this.writeStatus(); // carries the final lastEventAt of this change
  }

  private merge(part: {
    screen: Iterable<string>;
    backend: Iterable<string>;
    sidecar: Iterable<string>;
    params?: Iterable<string>;
    paramsRev?: number;
    claim?: boolean;
    requestRev?: number;
    retry?: Map<string, Target>;
    retrySidecars?: Map<string, Trigger>;
    retryWait?: Iterable<string>;
    startedAt: number;
    attempts: number;
  }): void {
    const pending: Pending = (this.pending ??= {
      screen: new Set(),
      backend: new Set(),
      sidecar: new Set(),
      params: new Set(),
      claim: false,
      retry: new Map(),
      retrySidecars: new Map(),
      retryWait: new Set(),
      startedAt: part.startedAt,
      attempts: part.attempts,
    });
    for (const f of part.screen) pending.screen.add(f);
    for (const f of part.backend) pending.backend.add(f);
    for (const f of part.sidecar) pending.sidecar.add(f);
    for (const k of part.params ?? []) pending.params.add(k);
    if (part.claim) pending.claim = true;
    for (const [p, t] of part.retry ?? []) if (!pending.retry.has(p)) pending.retry.set(p, t);
    for (const [f, t] of part.retrySidecars ?? []) if (!pending.retrySidecars.has(f)) pending.retrySidecars.set(f, t);
    for (const f of part.retryWait ?? []) pending.retryWait.add(f);
    if (part.paramsRev !== undefined) pending.paramsRev = Math.max(pending.paramsRev ?? 0, part.paramsRev);
    if (part.requestRev !== undefined) pending.requestRev = Math.max(pending.requestRev ?? 0, part.requestRev);
    pending.startedAt = Math.min(pending.startedAt, part.startedAt);
    pending.attempts = Math.max(pending.attempts, part.attempts);
  }

  /** Single consumer: batches that arrive while one is being captured are merged and handled together. */
  private async drain(): Promise<void> {
    try {
      while (this.pending && !this.stopping) {
        const batch = this.pending;
        this.pending = null;
        this.newWork = false;
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
    const paramKeys = [...batch.params].sort(); // v0.8: routes whose session params were just set
    const retryWait = [...batch.retryWait].filter((f) => !batch.screen.has(f)).sort();
    let requeued = false;
    const done = (outcome: BatchEvent['outcome'], routes: string[] = []): void => {
      this.events.emit('batch', { screen, backend, sidecar, routes, outcome } satisfies BatchEvent);
    };

    const marker = this.config.freshnessMarker;
    if (marker && !fs.existsSync(path.resolve(this.config.repoDir, marker))) {
      this.log(STALE_MESSAGE);
      this.status.lastError = STALE_MESSAGE; // so `finish` can say why there is no frame
      this.claimRefused(batch, STALE_MESSAGE);
      this.writeStatus();
      this.events.emit('refused', { reason: STALE_MESSAGE, marker, screen, backend });
      this.ackSessionParams(batch);
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
      // v0.13: the claim decides what is captured first; read once so the whole batch agrees.
      const claims = this.claimScreens();
      const targets = new Map<string, Target>();
      // Routes captured earlier this session are re-captured when the change cannot be traced to a route.
      let recapture: { trigger: Trigger; why: string; sourceFile: string } | null = null;
      // v0.13 backendScope "claim": a backend change re-captures the claim screens, not every route of the session.
      let backendClaim = false;
      // The data behind the list endpoints may have changed (a re-seed): look the ids up again.
      if (backend.length > 0) {
        this.paramSources.invalidate();
        this.discoverer?.invalidate(); // v0.8: discovered ids are as stale as list-endpoint ids
      }
      if (screen.length > 0) {
        const [barrier, resolution] = await Promise.all([
          this.waitBarrier(batch.startedAt, [...screen, ...retryWait]),
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
      } else if (retryWait.length > 0) {
        const barrier = await this.waitBarrier(batch.startedAt, retryWait);
        mark('barrier');
        this.log(`batch retry (${retryWait.join(',')} changed during the last capture) barrier=${barrier}`);
      }
      if (backend.length > 0) {
        if (screen.length === 0) this.log(`batch backend=${backend.join(',')}`);
        if (this.config.backendScope === 'claim' && claims.size > 0) {
          backendClaim = true;
          this.log(`backend change: backendScope "claim", re-capturing the claim screens, not the ${this.sessionRoutes.size} route(s) captured this session`);
        } else {
          if (this.config.backendScope === 'claim') this.log('backend change: backendScope "claim", but the claim names no screens yet, so every route captured this session is re-captured');
          recapture = { trigger: 'backend', why: 'backend change', sourceFile: backend[0]! };
        }
      }
      // v0.8: `visual-proof params set` routes are captured at the current tree whatever else changed.
      if (paramKeys.length > 0) this.addSessionTargets(paramKeys, targets);
      if (recapture) {
        for (const [capturedPath, route] of this.sessionRoutes) {
          // Re-resolve: a re-run seeder may have moved a param route to a new id since it was captured.
          const concrete = concretePath(route.routeKey, params);
          let routePath = concrete.ok ? concrete.path : capturedPath;
          let url = concrete.ok ? joinUrl(this.config.appUrl, routePath) : route.url;
          let provenance: Provenance = concrete.ok ? this.provenanceOf(route.routeKey) : { paramsFrom: route.paramsFrom, foundOn: route.foundOn };
          if (!concrete.ok && this.filler?.canFill(route.routeKey)) {
            const outcome = await this.fillRoute(route.routeKey);
            if (!outcome.ok) {
              this.log(`skipped route ${route.routeKey}: ${outcome.reason}`);
              continue;
            }
            routePath = outcome.path;
            url = joinUrl(this.config.appUrl, routePath);
            provenance = { paramsFrom: outcome.from, foundOn: outcome.foundOn, discoveryMs: outcome.discoveryMs };
          }
          if (!targets.has(routePath)) {
            targets.set(routePath, { path: routePath, routeKey: route.routeKey, url, trigger: recapture.trigger, sourceFile: recapture.sourceFile, tier: 'impact', ...provenance });
          }
        }
        if (this.sessionRoutes.size === 0) this.log(`${recapture.why}: no routes captured this session yet`);
        else if (recapture.trigger === 'screen') this.log(`${recapture.why}: re-capturing ${this.sessionRoutes.size} route(s) captured this session`);
      }
      for (const [routePath, target] of batch.retry) if (!targets.has(routePath)) targets.set(routePath, target);
      const extraScenarios = new Map(batch.retrySidecars);
      const before = await beforeP;
      if (batch.claim || backendClaim) {
        const force = backendClaim ? { trigger: 'backend' as const, sourceFile: backend[0]! } : undefined;
        for (const [file, trigger] of await this.addClaimTargets(targets, params, before, force)) {
          if (!extraScenarios.has(file)) extraScenarios.set(file, trigger);
        }
      }

      const scenarios = await this.pickScenarios({ changed: sidecar, screen, recapture: recapture?.trigger ?? null, params, extra: extraScenarios });

      if (targets.size === 0 && scenarios.length === 0) {
        this.log('no routes to capture');
        done('no-routes');
        await this.refreshClaim(before, eventsBefore, batch);
        return;
      }

      mark('resolve');
      // v0.13: the claim screens (routes, then the sidecars with a claimed still) are a round of their own, recorded
      // before anything else is captured, so `ready --claim` and `finish` need not wait for the impact routes.
      const jobs = this.orderJobs(targets, scenarios, claims);
      const rounds = [jobs.filter((j) => j.tier === 'claim'), jobs.filter((j) => j.tier !== 'claim')].filter((r) => r.length > 0);
      this.status.queue = jobs.length;
      this.status.remaining = { claim: 0, headline: 0, impact: 0 };
      for (const job of jobs) this.status.remaining[job.tier]++;
      this.jobsLeft = new Set(jobs.map(jobKey));
      this.writeStatus();
      if (rounds[0]![0]!.tier !== 'claim') await this.refreshClaim(before, eventsBefore, batch);

      let tree = before;
      let events = eventsBefore;
      const kept: string[] = [];
      const dropped: string[] = [];
      let captureFailed = false;
      // Called by the batch's last round right after it records its frames, so the batch event follows them at once.
      const close = (outcome: Extract<RoundOutcome, { after: string }>): void => {
        kept.push(...outcome.kept);
        dropped.push(...outcome.dropped);
        captureFailed ||= outcome.captureFailed;
        mark('write');
        if (!captureFailed && kept.length > 0) this.status.lastError = null; // the last problem is resolved
        this.log(`timing ${JSON.stringify(lap)} (ms since batch start; the debounce before it is not included)`);
        if (kept.length === 0 && dropped.length > 0) done('discarded', dropped);
        else done('captured', kept);
      };
      for (const [index, round] of rounds.entries()) {
        const claimRound = round[0]!.tier === 'claim';
        const last = index === rounds.length - 1;
        const outcome = await this.captureRound(round, { batch, before: tree, eventsBefore: events, preemptible: !claimRound, mark, close: last ? close : undefined });
        if (outcome === null) return; // stopping
        if ('unknown' in outcome) {
          // Cannot tell which frames the change reaches: none of this round can be trusted.
          const requeue = batch.attempts < (this.opts.maxRequeues ?? 2);
          if (requeue && index === 0) {
            // Nothing recorded yet: the whole batch goes again. Not the old batch's startedAt: that would let a message
            // from before this capture satisfy the next barrier.
            this.merge({ screen, backend, sidecar, params: paramKeys, paramsRev: batch.paramsRev, claim: batch.claim, requestRev: batch.requestRev, retry: batch.retry, retrySidecars: batch.retrySidecars, retryWait, startedAt: Date.now(), attempts: batch.attempts + 1 });
            requeued = true;
          } else if (requeue) {
            // The claim round is recorded and stands: only this round's captures go again.
            const retry = new Map<string, Target>();
            const retrySidecars = new Map<string, Trigger>();
            for (const job of round) {
              if ('route' in job) retry.set(job.route.path, job.route);
              else retrySidecars.set(job.scenario.sidecar.file, job.scenario.trigger);
            }
            this.merge({ screen: [], backend: [], sidecar: [], paramsRev: batch.paramsRev, retry, retrySidecars, retryWait: screen, startedAt: Date.now(), attempts: batch.attempts + 1 });
            requeued = true;
          }
          if (kept.length > 0) done('captured', kept);
          else done('discarded', [...dropped, ...outcome.routes]);
          await this.refreshClaim(tree, events, batch); // answer a claim request either way
          return;
        }
        tree = outcome.after;
        events = outcome.eventsAfter;
        requeued ||= outcome.requeued;
        if (last) break;
        kept.push(...outcome.kept);
        dropped.push(...outcome.dropped);
        captureFailed ||= outcome.captureFailed;
        // The claim round is recorded: say so now, before the rest of the batch is captured.
        await this.refreshClaim(tree, events, batch);
      }
      // The batch event went out with the last frames; the claim status follows.
      await this.refreshClaim(tree, events, batch);
    } catch (err) {
      this.fail(err as Error);
      done('error');
      // A claim request this batch carried must still be answered, or `ready --claim` waits for nothing.
      if (batch.requestRev !== undefined) this.claimRefused(batch, `the batch failed: ${(err as Error).message.split('\n')[0]}`);
    } finally {
      delete this.status.queue;
      delete this.status.remaining;
      this.jobsLeft = new Set();
      if (!requeued) this.ackSessionParams(batch);
      if (!this.stopping) this.setState('ready');
      if (this.graphStale && !this.stopping) this.refreshGraph();
    }
  }

  /**
   * The captures of a batch in the order they run: claim screens (routes, then sidecars with a claimed still), then
   * the other headlines (changed pages, `params set` routes, changed sidecars), then impact routes and the scenarios
   * replayed for them.
   */
  private orderJobs(targets: Map<string, Target>, scenarios: ScenarioJob[], claims: Set<string>): Job[] {
    const named = (labels: string[]): boolean => labels.some((label) => claims.has(normalizeScreen(label)));
    const routeJobs: Job[] = [...targets.values()].map((target) => {
      const tier: Tier = named([target.path, target.routeKey]) ? 'claim' : target.tier === 'impact' ? 'impact' : 'headline';
      return { tier, route: { ...target, tier } };
    });
    const scenarioJobs: Job[] = scenarios.map((scenario) => {
      const { file, name, stills } = scenario.sidecar;
      const claimed = stills.some((still) => named(screenLabels({ route: '', routeKey: '', sourceFiles: [], via: 'sidecar', scenario: { file, name, still } })));
      const tier: Tier = claimed ? 'claim' : scenario.trigger === 'sidecar' || scenario.trigger === 'claim' ? 'headline' : 'impact';
      return { tier, scenario };
    });
    const order: Tier[] = ['claim', 'headline', 'impact'];
    return order.flatMap((tier) => [...routeJobs.filter((j) => j.tier === tier), ...scenarioJobs.filter((j) => j.tier === tier)]);
  }

  /**
   * Capture one round of a batch, then hash the tree and keep the frames the changes made meanwhile cannot reach. A
   * preemptible round (everything after the claim screens) stops between captures once new work is queued (a save,
   * a claim request) and hands what it did not start to the next batch, so claim screens never wait behind impact
   * routes. Impact routes run `focus.impactConcurrency` at a time. Null when the watcher is stopping.
   */
  private async captureRound(
    jobs: Job[],
    ctx: {
      batch: Pending;
      before: string;
      eventsBefore: number;
      preemptible: boolean;
      mark: (name: string) => void;
      /** Set on the batch's last round: called right after the frames are recorded. */
      close?: (outcome: Extract<RoundOutcome, { after: string }>) => void;
    },
  ): Promise<RoundOutcome | null> {
    const treeHash = this.opts.treeHash ?? workingTreeHash;
    const { before, eventsBefore, batch } = ctx;
    const captureStart = Date.now();
    const captured: Captured[] = [];
    const attempted: string[] = [];
    const ranScenarios: string[] = [];
    let captureFailed = false;
    let leftover: Job[] = [];
    // Only work from outside the batch preempts it: its own re-queued captures wait their turn.
    const halt = (): boolean => this.stopping || (ctx.preemptible && this.newWork);

    const runRoute = async (target: Target): Promise<void> => {
      attempted.push(target.path);
      try {
        const result = await this.capturer!.capture(target.url);
        captured.push({ target, at: new Date().toISOString(), png: result.png, signals: result.signals, renderedFiles: result.renderedFiles ?? null, timing: result.timing, pageText: result.pageText });
      } catch (err) {
        captureFailed = true;
        this.fail(new Error(`capture ${target.path} failed: ${(err as Error).message}`));
      }
    };
    const runScenario = async (job: ScenarioJob): Promise<void> => {
      const file = job.sidecar.file;
      if (!this.capturer!.runScenario) {
        this.log(`sidecar ${file} skipped: this capturer cannot run scenarios`);
        return;
      }
      const recording = (await this.motionEnabled()) ? this.timeline.newClip() : undefined;
      const plan: ScenarioPlan = recording ? { ...job.plan, record: { dir: recording.dir, holdMs: Math.round(this.config.replay.secondsPerFrame * 1000) } } : job.plan;
      try {
        const result = await this.capturer!.runScenario(plan);
        const clip = recording && result.clip ? recording.clip : undefined;
        if (recording && !clip) this.timeline.dropClip(recording.clip);
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
            clip,
            job,
          });
        }
        ranScenarios.push(file);
        this.log(
          `sidecar ${file}: ${result.stills.filter((x) => !x.failed).length} still(s) in ${result.ms} ms` +
            (result.clip ? `; clip of ${result.clip.seconds} s (${result.clip.frames} frames)` : '') +
            (result.failure ? `; failed at line ${result.failure.line} ${result.failure.text}: ${result.failure.reason}` : ''),
        );
      } catch (err) {
        if (recording) this.timeline.dropClip(recording.clip);
        captureFailed = true;
        this.fail(new Error(`sidecar ${file} failed: ${(err as Error).message}`));
      }
    };
    const run = async (job: Job): Promise<void> => {
      if ('route' in job) await runRoute(job.route);
      else await runScenario(job.scenario);
      this.jobDone(job);
    };

    const concurrency = this.config.focus.impactConcurrency;
    for (let i = 0; i < jobs.length; ) {
      if (this.stopping) return null;
      if (halt()) {
        leftover = jobs.slice(i);
        break;
      }
      let end = i + 1;
      if (concurrency > 1 && isImpactRoute(jobs[i]!)) while (end < jobs.length && isImpactRoute(jobs[end]!)) end++;
      if (end - i > 1) {
        // Impact routes side by side; a scenario never runs next to them (`login <role>` switches the shared session).
        const notStarted = await runPool(jobs.slice(i, end), concurrency, run, halt);
        if (this.stopping) return null;
        if (notStarted.length > 0) {
          leftover = [...notStarted, ...jobs.slice(end)];
          break;
        }
      } else {
        await run(jobs[i]!);
      }
      i = end;
    }

    ctx.mark('captures');
    // Events from here on may be about the tree hashed next; the next round counts them as its own too.
    const eventsAfter = this.trigger?.eventCount() ?? 0;
    const after = await treeHash(this.config.repoDir, this.dirs.scratchDir);
    ctx.mark('hash');
    if (this.stopping) return null;
    let requeued = false;
    if (leftover.length > 0) {
      const retry = new Map<string, Target>();
      const retrySidecars = new Map<string, Trigger>();
      for (const job of leftover) {
        if ('route' in job) retry.set(job.route.path, job.route);
        else retrySidecars.set(job.scenario.sidecar.file, job.scenario.trigger);
      }
      // Not a failed attempt: the captures were only put off, so the batch keeps its attempt count.
      this.merge({ screen: [], backend: [], sidecar: [], paramsRev: batch.paramsRev, retry, retrySidecars, startedAt: captureStart, attempts: batch.attempts });
      requeued = true;
      this.log(`preempted: ${leftover.length} capture(s) of this batch moved behind new work (claim screens first)`);
    }

    const eventsDuring = (this.trigger?.eventCount() ?? 0) - eventsBefore;
    let keep = captured;
    const droppedRuns = new Set<string>();
    let keptRoutes = [...attempted, ...captured.filter((c) => c.steps).map((c) => c.target.path)];
    let droppedRoutes: string[] = [];
    if (after !== before || eventsDuring > 0) {
      const maxRequeues = this.opts.maxRequeues ?? 2;
      const why =
        after !== before
          ? `working tree changed during capture (${before.slice(0, 8)} -> ${after.slice(0, 8)})`
          : `${eventsDuring} file event(s) arrived during capture (tree unchanged: ${after.slice(0, 8)})`;
      const split = await this.splitMidCapture(captured, { before, after, eventsBefore, eventsDuring });
      if (this.stopping) return null;
      if ('unknown' in split) {
        const requeue = batch.attempts < maxRequeues;
        this.log(`discarded ${captured.length} frame(s): ${why}; ${split.unknown}` + (requeue ? '; re-queued' : '; giving up after repeated changes'));
        for (const clip of new Set(captured.map((c) => c.clip))) if (clip) this.timeline.dropClip(clip);
        const routes = [...attempted, ...captured.filter((c) => c.steps).map((c) => c.target.path)];
        this.events.emit('discarded', { routes, before, after, requeued: requeue, events: eventsDuring });
        return { unknown: split.unknown, routes };
      }
      keep = split.kept;
      keptRoutes = keep.map((c) => c.target.path);
      if (split.dropped.length === 0) {
        this.log(`kept ${keep.length} frame(s), discarded 0: ${why}, but nothing they show depends on ${split.files.join(', ') || 'it'}`);
      } else {
        const requeue = batch.attempts < maxRequeues;
        const reasons = split.dropped.map((d) => `${d.label} (${d.why})`);
        const listed = reasons.length > 5 ? [...reasons.slice(0, 5), `${reasons.length - 5} more`] : reasons;
        this.log(
          `kept ${keep.length} frame(s), discarded ${split.dropped.length}: ${why}; stale: ${listed.join(', ')}` +
            (requeue ? '; re-queued' : '; giving up after repeated changes'),
        );
        const droppedEntries = split.dropped.flatMap((d) => d.entries);
        for (const entry of droppedEntries) if (entry.job) droppedRuns.add(entry.job.sidecar.file);
        for (const clip of new Set(droppedEntries.map((c) => c.clip))) if (clip) this.timeline.dropClip(clip);
        droppedRoutes = droppedEntries.map((c) => c.target.path);
        this.events.emit('discarded', { routes: droppedRoutes, kept: keptRoutes, before, after, requeued: requeue, events: eventsDuring });
        if (requeue) {
          const retry = new Map<string, Target>();
          const retrySidecars = new Map<string, Trigger>();
          for (const entry of droppedEntries) {
            if (entry.job) retrySidecars.set(entry.job.sidecar.file, entry.job.trigger);
            else retry.set(entry.target.path, entry.target);
          }
          // Since the capture started, not before: the barrier must not credit a message for the save that began this batch.
          this.merge({ screen: [], backend: [], sidecar: [], paramsRev: batch.paramsRev, retry, retrySidecars, retryWait: split.screenFiles, startedAt: captureStart, attempts: batch.attempts + 1 });
          requeued = true;
        }
      }
    }

    this.record(keep, after);
    for (const file of ranScenarios) if (!droppedRuns.has(file)) this.sidecarsRun.add(file);
    const outcome = { after, eventsAfter, kept: keptRoutes, dropped: droppedRoutes, captureFailed, requeued, preempted: leftover.length > 0 };
    ctx.close?.(outcome);
    return outcome;
  }

  /**
   * Record frames at `after`. A kept frame depends on nothing that differs between the tree its round started at and
   * `after`, so it shows `after` as much as the earlier tree; recording it at the current tree lets `finish` match it at
   * HEAD without carrying it.
   */
  private record(keep: Captured[], after: string): void {
    for (const { target, at, png, signals, renderedFiles, timing, pageText, steps, clip } of keep) {
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
          ...(timing ? { timing: { ...timing, ...(target.discoveryMs !== undefined ? { discoveryMs: target.discoveryMs } : {}) } } : {}),
          ...(steps ? { steps } : {}),
          ...(clip ? { clip } : {}),
          ...(target.paramsFrom ? { paramsFrom: target.paramsFrom } : {}),
          ...(target.foundOn ? { paramsFoundOn: target.foundOn } : {}),
        },
        png,
      );
      // A4: the page text for the claim check lives next to the PNG, not in index.jsonl.
      if (pageText !== undefined && this.config.decisions.verdict && this.config.decisions.enabled !== false) {
        writeTextSidecar(this.timeline.pngPath(frame), pageText);
      }
      if (!steps) this.sessionRoutes.set(target.path, { routeKey: target.routeKey, url: target.url, paramsFrom: target.paramsFrom, foundOn: target.foundOn });
      this.status.frames++;
      this.status.lastCaptureAt = at;
      this.log(
        `frame ${frame.id} ${frame.route} ${frame.status}${frame.reasons.length ? ` (${frame.reasons[0]})` : ''} tree=${after.slice(0, 8)}`,
      );
      this.events.emit('frame', { frame, signals, pngPath: this.timeline.pngPath(frame) } satisfies FrameEvent);
    }
  }

  /** One capture of the batch is over: count it off `status.remaining`. */
  private jobDone(job: Job): void {
    this.jobsLeft.delete(jobKey(job));
    const remaining = this.status.remaining;
    if (remaining && remaining[job.tier] > 0) remaining[job.tier]--;
    this.writeStatus();
  }

  /**
   * Which frames of a batch still stand after files changed while it was being captured. The files are those that
   * differ between the trees before and after the capture plus those with a file event during it (a save reverted
   * before the second hash still counts); a frame goes when one of them can have changed it, by the rules `finish`
   * carries frames forward with ({@link staleCheck}). A sidecar run is kept or dropped as a whole. `unknown` says why
   * this cannot be established (no import graph, git cannot compare the trees, a trigger that only counts events).
   */
  private async splitMidCapture(
    captured: Captured[],
    change: { before: string; after: string; eventsBefore: number; eventsDuring: number },
  ): Promise<
    | { kept: Captured[]; dropped: Array<{ label: string; why: string; entries: Captured[] }>; files: string[]; screenFiles: string[] }
    | { unknown: string }
  > {
    let touched: string[] = [];
    if (change.eventsDuring > 0) {
      const paths = this.trigger?.eventsSince?.(change.eventsBefore);
      if (!paths) return { unknown: 'the trigger does not say which files the events were for' };
      touched = paths;
    }
    let diff: string[] = [];
    if (change.after !== change.before) {
      const files = await treeDiff(this.config.repoDir, change.before, change.after);
      if (files === null) return { unknown: 'git cannot compare the two trees' };
      diff = files;
    }
    const files = [...new Set([...diff, ...touched])].sort();
    const { isScreen, isSidecar } = classifier(this.config);
    let graph: ImportGraph;
    try {
      graph = await this.getGraph();
    } catch {
      // v0.13: a sidecar file can only change its own run; no graph is needed to tell that.
      if (files.length === 0 || !files.every((f) => isSidecar(f))) return { unknown: 'no import graph to tell which frames the change reaches' };
      graph = { fileToRoutes: new Map(), routes: [], unresolved: [] };
    }
    const stale = staleCheck(this.config, graph);
    const knownKeys = [...graph.routes.map((r) => r.path), ...Object.values(this.config.staticRoutes).flat()];

    const kept: Captured[] = [];
    const dropped: Array<{ label: string; why: string; entries: Captured[] }> = [];
    const runs = new Map<ScenarioJob, Captured[]>();
    for (const entry of captured) {
      if (entry.job) {
        const run = runs.get(entry.job) ?? [];
        run.push(entry);
        runs.set(entry.job, run);
        continue;
      }
      const why = stale(files, { keys: [entry.target.routeKey], renderedFiles: entry.renderedFiles });
      if (why === null) kept.push(entry);
      else dropped.push({ label: entry.target.path, why, entries: [entry] });
    }
    for (const [job, entries] of runs) {
      const keys = scenarioRouteKeys(job.sidecar, knownKeys);
      const why = entries.map((e) => stale(files, { keys, sidecarFile: job.sidecar.file, renderedFiles: e.renderedFiles })).find((w) => w !== null) ?? null;
      if (why === null) kept.push(...entries);
      else dropped.push({ label: `sidecar ${job.sidecar.file}`, why, entries });
    }
    return { kept, dropped, files, screenFiles: files.filter((f) => isScreen(f)) };
  }

  // ---- sidecars ------------------------------------------------------------

  /** Probed once: recording is pointless without an ffmpeg that can turn the clips into the replay. */
  private motionEnabled(): Promise<boolean> {
    const { replay } = this.config;
    this.motion ??=
      replay.enabled && replay.motion
        ? probeFfmpeg(this.opts.env ?? process.env).then(
            (info) => {
              const ok = info.found && info.x264;
              if (!ok) this.log(`motion clips off: ${info.found ? 'this ffmpeg has no libx264 encoder' : (info.reason ?? 'ffmpeg not found')}; the replay shows stills`);
              return ok;
            },
            () => false,
          )
        : Promise.resolve(false);
    return this.motion;
  }

  /**
   * The scenarios to replay for this batch: the sidecar files that changed; those with a `goto` on a route that a
   * changed screen file renders (through the import graph); and, when the batch re-captures routes (a backend
   * change, or a screen file with no route), every scenario that has run this session; plus `extra` (v0.12: runs to
   * repeat after a change during them, and scenarios with a still the claim names). A scenario that does not parse
   * is logged and skipped: `finish` reports it.
   */
  private async pickScenarios(batch: {
    changed: string[];
    screen: string[];
    recapture: Trigger | null;
    params: Record<string, string>;
    extra?: Map<string, Trigger>;
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
    for (const [file, trigger] of batch.extra ?? []) if (existing.has(file) && !reasons.has(file)) reasons.set(file, trigger);

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

  /**
   * A `goto` target is a concrete path, or a route key filled through the same chain as every capture: session params,
   * the seed file, routeParams, paramSources, then link discovery (v0.8; `params` already has the first three).
   */
  private async resolveGoto(target: string, params: Record<string, string>): Promise<{ url: string; path: string } | { error: string }> {
    const concrete = concretePath(target, params);
    if (concrete.ok) return { path: concrete.path, url: joinUrl(this.config.appUrl, concrete.path) };
    if (this.filler?.canFill(target)) {
      const outcome = await this.fillRoute(target);
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

  /** Session params over the seed file over config `routeParams`, re-read per batch. Problems are logged once per distinct message. */
  private readRouteParams(): Record<string, string> {
    const layered = this.layered();
    const key = layered.problems.join('\n');
    if (key !== this.lastParamsProblems) {
      this.lastParamsProblems = key;
      for (const problem of layered.problems) this.log(`warning: ${problem}`);
    }
    return layered.params;
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
    // v0.11 focus: claim screens and changed pages first; the other routes the change reaches are capped at maxImpact.
    const isHeadline = this.headlineTest(graph);
    if (isHeadline) {
      const byFocus = <T extends { path?: string; routeKey: string; sourceFiles: string[] }>(list: T[]): T[] => [
        ...list.filter((r) => isHeadline(r)),
        ...list.filter((r) => !isHeadline(r)),
      ];
      let impactLeft = this.config.focus.maxImpact;
      const keep = <T extends { path?: string; routeKey: string; sourceFiles: string[] }>(r: T): boolean => isHeadline(r) || impactLeft-- > 0;
      const routes = byFocus(resolution.routes).filter(keep);
      const skipped = byFocus(resolution.skipped).filter(keep);
      const dropped = resolution.routes.length + resolution.skipped.length - routes.length - skipped.length;
      if (dropped > 0) this.log(`focus: ${dropped} impact route(s) over focus.maxImpact (${this.config.focus.maxImpact}) not captured`);
      resolution.routes = routes;
      resolution.skipped = skipped;
    }
    // v0.13: claim screens are picked out again when the batch is ordered; here only headline vs impact matters.
    const tierOf = (r: { path?: string; routeKey: string; sourceFiles: string[] }): Tier => (isHeadline === null || isHeadline(r) ? 'headline' : 'impact');
    const targets: Target[] = resolution.routes.map((r) => ({
      path: r.path,
      routeKey: r.routeKey,
      url: r.url,
      trigger: 'screen' as const,
      sourceFile: r.sourceFiles[0],
      tier: tierOf(r),
      ...this.provenanceOf(r.routeKey),
    }));
    for (const skip of resolution.skipped) {
      if (!this.filler?.canFill(skip.routeKey)) {
        this.log(`skipped route ${skip.routeKey}: ${skip.reason}`);
        continue;
      }
      // Neither the session, routeParams nor the seed file has it: ask the list endpoint, then the parent page's links.
      const outcome = await this.fillRoute(skip.routeKey);
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
        tier: tierOf(skip),
        paramsFrom: outcome.from,
        foundOn: outcome.foundOn,
        discoveryMs: outcome.discoveryMs,
      });
    }
    return { targets, unmapped: resolution.unmapped };
  }

  /**
   * Whether a route is a headline (a claim screen, or a page whose own component or layout changed), or null when
   * focus does not apply (`focus.mode` is `all`). Before the claim names a screen, only changed pages are headlines,
   * so a shared component still captures at most `focus.maxImpact` other routes (v0.12); naming the screens later
   * captures them (see {@link onClaim}).
   */
  private headlineTest(graph: ImportGraph): ((r: { path?: string; routeKey: string; sourceFiles: string[] }) => boolean) | null {
    if (this.config.focus.mode !== 'claim') return null;
    const screens = this.claimScreens();
    if (screens.size === 0 && !this.noClaimNoted) {
      this.noClaimNoted = true;
      this.log(
        `focus: no claim screens yet (${this.claimFile()}); capturing changed pages first and at most ${this.config.focus.maxImpact} other routes. ` +
          'Name the screens in the claim to pick the headlines.',
      );
    }
    return (r) =>
      (r.path !== undefined && screens.has(normalizeScreen(r.path))) ||
      screens.has(normalizeScreen(r.routeKey)) ||
      r.sourceFiles.some((file) => directlyTouches(graph, r.routeKey, file));
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

  // ---- dynamic params (v0.8) ----------------------------------------------

  /** Session, seed-file and config params merged; remembers which tier each key came from. */
  private layered(): LayeredParams {
    const layered = loadLayeredParams(this.config, this.files.sessionParams);
    this.paramOrigin = layered.origin;
    return layered;
  }

  /** `paramsFrom` for a route filled by the session, seed file or config; none for a route without params. */
  private provenanceOf(routeKey: string): Provenance {
    const from = this.paramOrigin[routeKey];
    return from !== undefined && hasParams(routeKey) ? { paramsFrom: from } : {};
  }

  /** Link discovery needs a browser that can collect links; the filler chains source and discovery behind the cheap tiers. */
  private setupParamFiller(): void {
    const capturer = this.capturer;
    if (this.config.paramDiscovery === 'links' && capturer?.collectLinks) {
      this.discoverer = new ParamDiscoverer({
        appUrl: this.config.appUrl,
        collect: (url) => capturer.collectLinks!(url),
        routes: async () => {
          const graph = await this.getGraph();
          return [...new Set([...graph.routes.map((r) => r.path), ...Object.values(this.config.staticRoutes).flat()])];
        },
        fillParent: async (routeKey, depth) => {
          const outcome = await this.filler!.fill(routeKey, depth);
          return outcome.ok ? { ok: true, path: outcome.path } : outcome;
        },
        onCacheChange: (entries) => writeDiscoveryCache(this.files.paramDiscovery, this.sessionId, entries),
        log: (m) => this.log(m),
      });
    }
    this.filler = new ParamFiller({
      layered: () => this.layered(),
      hasSource: (key) => this.paramSources.has(key),
      fromSource: (key) => this.fromSource(key),
      discoverer: this.discoverer,
      onDiscovery: (key, outcome) => this.recordDiscovery(key, outcome),
    });
  }

  private fillRoute(routeKey: string): Promise<FillOutcome> {
    return this.filler!.fill(routeKey);
  }

  /** Keep the latest discovery outcome per route key in `status.json` so `finish` can say why a route stayed unfilled. */
  private recordDiscovery(routeKey: string, outcome: DiscoveryOutcome): void {
    const entries = (this.status.paramDiscovery ??= {});
    const before = entries[routeKey];
    if (outcome.ok) {
      entries[routeKey] = { path: outcome.path, foundOn: outcome.foundOn, at: new Date().toISOString() };
    } else {
      if (before?.error !== outcome.reason) this.log(`warning: param discovery for ${routeKey}: ${outcome.reason}`);
      entries[routeKey] = { ...(before?.path !== undefined ? { path: before.path, foundOn: before.foundOn } : {}), error: outcome.reason, at: new Date().toISOString() };
    }
    this.writeStatus();
  }

  /** Targets for routes whose session params were just set; a route cleared since is skipped. */
  private addSessionTargets(keys: string[], targets: Map<string, Target>): void {
    const { routes } = readSessionParams(this.files.sessionParams);
    for (const routeKey of keys) {
      const entry = routes[routeKey];
      if (!entry) continue;
      targets.set(entry.path, { path: entry.path, routeKey, url: joinUrl(this.config.appUrl, entry.path), trigger: 'params', paramsFrom: 'session', tier: 'headline' });
    }
  }

  /** Watch `session-params.json`: a `params set` from the CLI queues its route for capture at the current tree. */
  private async startSessionWatch(): Promise<void> {
    const session = readSessionParams(this.files.sessionParams);
    this.sessionSeen = session.routes; // entries from before this watcher started are tier-one params, but not captured by themselves
    this.status.sessionParamsRev = session.rev;
    if (Object.keys(session.routes).length > 0) this.log(`session params: ${Object.keys(session.routes).join(', ')} (from ${this.files.sessionParams})`);
    const watch = this.opts.watchSession ?? watchSessionParams;
    this.sessionWatch = await watch(this.files.sessionParams, () => this.onSessionParams(), (err) => this.fail(err));
  }

  private onSessionParams(): void {
    if (this.stopping) return;
    const session = readSessionParams(this.files.sessionParams);
    const changed = changedSessionRoutes(this.sessionSeen, session.routes);
    this.sessionSeen = session.routes;
    if (changed.length === 0) {
      // A clear, or a rewrite that changed nothing: nothing to capture, but `params set` may be waiting on the revision.
      if (session.rev > (this.status.sessionParamsRev ?? 0) && this.pending === null) {
        this.status.sessionParamsRev = session.rev;
        this.writeStatus();
      }
      return;
    }
    this.log(`session params set for ${changed.join(', ')}; capturing`);
    this.newWork = true;
    this.merge({ screen: [], backend: [], sidecar: [], params: changed, paramsRev: session.rev, startedAt: Date.now(), attempts: 0 });
    if (!this.warmingUp) this.running ??= this.drain();
    this.refreshPending();
    this.writeStatus();
  }

  /** The session file revision this batch came from is handled (captured, refused or dropped): tell `params set`. */
  private ackSessionParams(batch: Pending): void {
    if (batch.paramsRev === undefined || this.stopping) return;
    this.status.sessionParamsRev = Math.max(this.status.sessionParamsRev ?? 0, batch.paramsRev);
  }

  // ---- claim (v0.12) -------------------------------------------------------

  private claimFile(): string {
    return claimPath(this.config.claimFile, this.config.repoDir, this.dirs.statusDir);
  }

  /** The screens the claim's `<screen>: <what must be visible>` lines name, normalized; empty without a claim. */
  private claimScreens(): Set<string> {
    const claim = readClaim(this.claimFile());
    const screens = new Set([...parseExpectations('text' in claim ? claim.text : undefined).keys()].map(normalizeScreen));
    if (screens.size > 0) this.noClaimNoted = false;
    return screens;
  }

  /** Watch the claim file: when it names a new screen, capture the claim screens that have no clean frame yet. */
  private async startClaimWatch(): Promise<void> {
    if (this.config.focus.mode !== 'claim') return;
    this.claimSeen = this.claimScreens(); // a claim from before this watcher started is read per batch, not captured by itself
    const file = this.claimFile();
    if (!this.opts.watchClaim && !fs.existsSync(path.dirname(file))) {
      this.log(`claim: ${path.dirname(file)} does not exist, so a claim written later is read on the next save only`);
      return;
    }
    const watch = this.opts.watchClaim ?? watchFile;
    this.claimWatch = await watch(file, () => this.onClaim(), (err) => this.fail(err));
  }

  private onClaim(): void {
    if (this.stopping) return;
    const screens = this.claimScreens();
    const added = [...screens].filter((s) => !this.claimSeen.has(s));
    this.claimSeen = screens;
    if (added.length === 0) {
      void this.refreshClaimIdle(); // screens may have gone; the status should say so
      return;
    }
    this.log(`claim names ${added.join(', ')}; capturing the claim screens that have no clean frame at the current tree`);
    this.newWork = true;
    this.merge({ screen: [], backend: [], sidecar: [], claim: true, startedAt: Date.now(), attempts: 0 });
    if (!this.warmingUp) this.running ??= this.drain();
    this.refreshPending();
    this.writeStatus();
  }

  /**
   * Add a target for every claim screen that is a route (a key like `/facilities/:id`, filled through the params
   * chain, or a concrete path like `/facilities/3`) without a clean frame that stands at `tree`; return the sidecar files
   * with a still the claim names and no such frame, to replay. A frame stands when it is at `tree`, or at an earlier
   * tree and nothing changed since can reach it (v0.13). `force` (a backend change with `backendScope: "claim"`)
   * captures every claim screen again, with that trigger.
   */
  private async addClaimTargets(
    targets: Map<string, Target>,
    params: Record<string, string>,
    tree: string,
    force?: { trigger: Trigger; sourceFile: string },
  ): Promise<Map<string, Trigger>> {
    const screens = this.claimScreens();
    const scenarios = new Map<string, Trigger>();
    if (screens.size === 0) return scenarios;
    let knownKeys: string[] = Object.values(this.config.staticRoutes).flat();
    try {
      const graph = await this.getGraph();
      knownKeys = [...graph.routes.map((r) => r.path), ...knownKeys];
    } catch (err) {
      this.log(`claim: import graph unavailable: ${(err as Error).message.split('\n')[0]}`);
    }
    const carry = this.carryCheck(tree);
    const stands = async (route: string, deps: FrameDependencies): Promise<boolean> => !force && screenReady((await carry(route, deps)).state);
    const trigger = force?.trigger ?? 'claim';
    const added: string[] = [];
    for (const screen of [...screens].sort()) {
      if (!screen.startsWith('/')) continue;
      let routeKey = screen;
      let routePath: string;
      let provenance: Provenance = {};
      if (hasParams(screen)) {
        const concrete = concretePath(screen, params);
        if (concrete.ok) {
          routePath = concrete.path;
          provenance = this.provenanceOf(screen);
        } else if (this.filler?.canFill(screen)) {
          const outcome = await this.fillRoute(screen);
          if (!outcome.ok) {
            this.log(`claim: skipped ${screen}: ${outcome.reason}`);
            continue;
          }
          routePath = outcome.path;
          provenance = { paramsFrom: outcome.from, foundOn: outcome.foundOn, discoveryMs: outcome.discoveryMs };
        } else {
          this.log(`claim: skipped ${screen}: ${concrete.reason}`);
          continue;
        }
      } else {
        routePath = screen;
        routeKey = gotoRouteKeys(screen, knownKeys)[0] ?? screen;
      }
      if (targets.has(routePath) || (await stands(routePath, { keys: [routeKey] }))) continue;
      targets.set(routePath, {
        path: routePath,
        routeKey,
        url: joinUrl(this.config.appUrl, routePath),
        trigger,
        ...(force ? { sourceFile: force.sourceFile } : {}),
        tier: 'claim',
        ...provenance,
      });
      added.push(routePath);
    }
    if (this.config.sidecars.length > 0) {
      for (const file of findSidecarFiles(this.config.repoDir, this.config.sidecars)) {
        const sidecar = loadSidecar(this.config.repoDir, file);
        const named = sidecar.stills.some((still) =>
          screenLabels({ route: '', routeKey: '', sourceFiles: [], via: 'sidecar', scenario: { file, name: sidecar.name, still } }).some((label) => screens.has(normalizeScreen(label))),
        );
        if (!named) continue;
        const deps = { keys: scenarioRouteKeys(sidecar, knownKeys), sidecarFile: file };
        let standing = true;
        for (const still of sidecar.stills) if (!(await stands(sidecarRoute(file, still), deps))) standing = false;
        if (!standing) {
          scenarios.set(file, trigger);
          added.push(`sidecar ${file}`);
        }
      }
    }
    this.log(added.length > 0 ? `claim: capturing ${added.join(', ')}` : 'claim: every claim screen already has a clean frame at the current tree');
    return scenarios;
  }

  // ---- claim readiness (v0.13) ------------------------------------------------

  /**
   * Whether a route (or a sidecar still) has a frame that stands at `tree`: one at that tree, or a clean one at an
   * earlier tree that nothing changed since can reach, by the rules `finish` carries frames forward with.
   */
  private carryCheck(tree: string): (route: string, deps: FrameDependencies) => Promise<{ state: ClaimScreenState; frame?: Frame; reason?: string }> {
    const diffs = new Map<string, Promise<string[] | null>>();
    let check: Promise<ReturnType<typeof staleCheck> | null> | null = null;
    return async (route, deps) => {
      const atTree = this.timeline.latestAtTree(route, tree);
      if (atTree) return atTree.status === 'clean' ? { state: 'clean', frame: atTree } : { state: 'not-clean', frame: atTree, reason: atTree.reasons[0] ?? atTree.status };
      const older = this.timeline.latest(route);
      if (!older) return { state: 'missing' };
      const short = older.treeHash.slice(0, 8);
      if (older.status !== 'clean') return { state: 'missing', reason: `the last frame (tree ${short}) is ${older.status}` };
      check ??= this.getGraph().then(
        (graph) => staleCheck(this.config, graph),
        () => null,
      );
      const stale = await check;
      if (!stale) return { state: 'missing', reason: `the last clean frame is at tree ${short}, and there is no import graph to carry it` };
      let diff = diffs.get(older.treeHash);
      if (!diff) diffs.set(older.treeHash, (diff = treeDiff(this.config.repoDir, older.treeHash, tree)));
      const files = await diff;
      if (files === null) return { state: 'missing', reason: `the last clean frame is at tree ${short}, which git cannot compare` };
      const why = stale(files, { ...deps, renderedFiles: older.renderedFiles });
      return why === null ? { state: 'carried', frame: older } : { state: 'missing', reason: `stale: ${why} changed since tree ${short}` };
    };
  }

  /**
   * Work out, for every screen the claim names, whether it has a frame that stands at `tree` (hashed after `eventsAt`
   * events), and write it to `status.claim`. `batch` is the batch that looked; its claim request is acknowledged.
   */
  private async refreshClaim(tree: string, eventsAt: number, batch?: Pending): Promise<void> {
    try {
      await this.lookAtClaim(tree, eventsAt, batch);
    } catch (err) {
      // Never fatal for the batch: the next look tries again. A request it was answering is answered with the reason.
      const reason = `could not check the claim screens: ${(err as Error).message.split('\n')[0]}`;
      this.log(`claim: ${reason}`);
      if (batch?.requestRev !== undefined) {
        this.claimRefused(batch, reason);
        this.writeStatus();
      }
    }
  }

  private async lookAtClaim(tree: string, eventsAt: number, batch?: Pending): Promise<void> {
    const seq = ++this.claimSeq;
    this.lastTree = { tree, events: eventsAt };
    const screens = [...this.claimScreens()].sort();
    const carry = this.carryCheck(tree);
    const params = screens.some((s) => hasParams(s)) ? this.layered().params : {};
    let knownKeys: string[] = Object.values(this.config.staticRoutes).flat();
    try {
      knownKeys = [...(await this.getGraph()).routes.map((r) => r.path), ...knownKeys];
    } catch {
      // Without a graph, a concrete claim path stands for itself.
    }
    const sidecars =
      this.config.sidecars.length > 0 && screens.some((s) => !s.startsWith('/'))
        ? findSidecarFiles(this.config.repoDir, this.config.sidecars).map((file) => loadSidecar(this.config.repoDir, file))
        : [];
    const pending = this.pending;
    const queued = (key: string): boolean =>
      this.jobsLeft.has(key) || pending?.claim === true || pending?.retry.has(key) === true || pending?.retrySidecars.has(key.replace(/^sidecar:/, '')) === true;
    const entry = (screen: string, kind: 'route' | 'sidecar', target: string, found: { state: ClaimScreenState; frame?: Frame; reason?: string }, isQueued: boolean): ClaimScreenStatus => {
      const state: ClaimScreenState = screenReady(found.state) || !isQueued ? found.state : 'queued';
      return {
        screen,
        kind,
        target,
        state,
        ...(found.frame && state !== 'queued' ? { frameId: found.frame.id } : {}),
        ...(state === 'carried' && found.frame ? { frameTree: found.frame.treeHash } : {}),
        ...(found.reason && state !== 'queued' ? { reason: found.reason } : {}),
      };
    };

    const entries: ClaimScreenStatus[] = [];
    for (const screen of screens) {
      if (screen.startsWith('/')) {
        let route = screen;
        let routeKey = screen;
        if (hasParams(screen)) {
          const concrete = concretePath(screen, params);
          const filled = concrete.ok ? concrete.path : this.timeline.list().filter((f) => f.routeKey === screen).at(-1)?.route;
          if (!filled) {
            const reason = this.status.paramDiscovery?.[screen]?.error ?? this.status.paramSources?.[screen]?.error ?? (concrete.ok ? undefined : concrete.reason);
            entries.push({ screen, kind: 'route', state: pending?.claim ? 'queued' : 'unfilled', ...(reason ? { reason } : {}) });
            continue;
          }
          route = filled;
        } else {
          routeKey = gotoRouteKeys(screen, knownKeys)[0] ?? screen;
        }
        entries.push(entry(screen, 'route', route, await carry(route, { keys: [routeKey] }), queued(route)));
        continue;
      }
      let worst: ClaimScreenStatus | null = null;
      for (const sidecar of sidecars) {
        const deps = { keys: scenarioRouteKeys(sidecar, knownKeys), sidecarFile: sidecar.file };
        for (const still of sidecar.stills) {
          const labels = screenLabels({ route: '', routeKey: '', sourceFiles: [], via: 'sidecar', scenario: { file: sidecar.file, name: sidecar.name, still } });
          if (!labels.some((label) => normalizeScreen(label) === screen)) continue;
          let found = await carry(sidecarRoute(sidecar.file, still), deps);
          // A step that failed after the last still leaves a frame of its own; newer than the still, it stands for the run.
          const failed = this.timeline.latestAtTree(sidecarRoute(sidecar.file, FAILED_STILL), tree);
          if (failed && found.frame && frameNumber(failed.id) > frameNumber(found.frame.id)) found = { state: 'not-clean', frame: failed, reason: failed.reasons[0] ?? 'a step failed' };
          const e = entry(screen, 'sidecar', sidecar.file, found, queued(`sidecar:${sidecar.file}`));
          if (!worst || STATE_RANK[e.state] > STATE_RANK[worst.state]) worst = e;
        }
      }
      entries.push(worst ?? { screen, kind: 'unmatched', state: 'unmatched' });
    }
    if (seq !== this.claimSeq) return; // a later look already wrote a newer answer

    const waited = entries.filter((e) => e.kind !== 'unmatched');
    const captured = waited.filter((e) => screenReady(e.state)).length;
    const claim: ClaimStatus = {
      file: this.claimFile(),
      tree,
      current: (this.trigger?.eventCount() ?? 0) === eventsAt,
      ready: waited.length > 0 && captured === waited.length,
      total: waited.length,
      captured,
      screens: entries,
      request: Math.max(this.status.claim?.request ?? 0, batch?.requestRev ?? 0),
    };
    const changed = JSON.stringify(claim) !== JSON.stringify(this.status.claim);
    this.status.claim = claim;
    if (changed) {
      const waiting = entries.filter((e) => e.kind !== 'unmatched' && !screenReady(e.state));
      this.log(
        waited.length === 0
          ? 'claim: no claim screens to check'
          : `claim: ${captured}/${waited.length} claim screen(s) ready at tree ${tree.slice(0, 8)}` + (waiting.length > 0 ? ` (${waiting.map((e) => `${e.screen} ${e.state}`).join(', ')})` : ''),
      );
    }
    this.writeStatus();
  }

  /** Refresh the claim status between batches (a batch refreshes it itself). */
  private async refreshClaimIdle(): Promise<void> {
    if (this.stopping || this.running || this.pending || !this.lastTree) return;
    await this.refreshClaim(this.lastTree.tree, this.lastTree.events);
  }

  /** The claim screens cannot be captured (a stale freshness marker): say so, and acknowledge the request. */
  private claimRefused(batch: Pending, reason: string): void {
    const claim = this.status.claim;
    this.status.claim = {
      file: this.claimFile(),
      tree: claim?.tree ?? null,
      current: true,
      ready: false,
      total: claim?.total ?? 0,
      captured: 0,
      screens: claim?.screens ?? [],
      request: Math.max(claim?.request ?? 0, batch.requestRev ?? 0),
      error: reason,
    };
  }

  /** Watch `claim-request.json`: `ready --claim` and `finish` ask for the claim screens to be captured first. */
  private async startRequestWatch(): Promise<void> {
    const file = this.files.claimRequest;
    const earlier = readClaimRequest(file);
    // A request made while this watcher was starting (`start` then `ready --claim`) is answered once it is ready; an
    // older one was for another watcher.
    const at = earlier ? Date.parse(earlier.at) : Number.NaN;
    if (earlier && !(Number.isFinite(at) && Date.now() - at < RECENT_REQUEST_MS)) this.requestSeen = earlier.rev;
    if (!this.opts.watchClaimRequest && !fs.existsSync(path.dirname(file))) return;
    const watch = this.opts.watchClaimRequest ?? watchFile;
    this.requestWatch = await watch(file, () => this.onClaimRequest(), (err) => this.fail(err));
  }

  private onClaimRequest(): void {
    if (this.stopping) return;
    const request = readClaimRequest(this.files.claimRequest);
    if (!request || request.rev <= this.requestSeen) return;
    this.requestSeen = request.rev;
    this.log(`claim request from ${request.from}: capturing the claim screens${this.running ? ' before the rest of the running batch' : ''}`);
    this.newWork = true;
    this.merge({ screen: [], backend: [], sidecar: [], claim: true, requestRev: request.rev, startedAt: Date.now(), attempts: 0 });
    if (!this.warmingUp) this.running ??= this.drain();
    this.refreshPending();
    this.writeStatus();
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
