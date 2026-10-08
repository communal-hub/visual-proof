import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE_NAME, ConfigError, loadConfig, type Config } from './config.js';
import { EXIT } from './exit.js';
import { changeSet, headTree, isGitRepo, workingTreeHash } from './git.js';
import { classifier } from './globs.js';
import { ensureDirs, resolveDirs, statusFiles, type Dirs } from './paths.js';
import { buildImportGraph, type ImportGraph } from './resolve/import-graph.js';
import { loadRouteParams } from './resolve/route-params.js';
import { concretePath, resolveRoutes } from './resolve/routes.js';
import { readStatusFile, watcherPid, writeFileAtomic, type Status } from './status.js';
import { describeError } from './text.js';
import { Timeline, type Frame } from './timeline.js';
import type { FrameStatus } from './triage.js';

export interface FinishOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the status/artifact/scratch dirs (default: resolved from `env`). */
  dirs?: Dirs;
  /** Overrides `config.finishBudgetMs`. */
  budgetMs?: number;
  now?: () => number;
  buildGraph?: (config: Config) => Promise<ImportGraph>;
  /** How often to re-check a daemon that is still capturing. Default 200 ms. */
  pollMs?: number;
}

/** One expected route and what `finish` found for it. */
export interface RouteProof {
  /** Concrete path that was (or should have been) captured. */
  route: string;
  routeKey: string;
  /** Changed files that led here; backend-triggered routes list the backend files. */
  sourceFiles: string[];
  via: 'screen' | 'backend';
  /** Set when a frame at HEAD's tree exists. */
  status?: FrameStatus;
  reasons: string[];
  frameId?: string;
  sessionId?: string;
  /** Absolute path of the copied headline PNG. */
  artifact?: string;
}

export interface FinishResult {
  ok: boolean;
  failures: string[];
  /** What to do about the failures (start the watcher, commit, ...); empty when `ok`. */
  hints: string[];
  notes: string[];
  routes: RouteProof[];
  noScreenChanges: boolean;
  truncated: boolean;
  /** `HEAD^{tree}`, or null when HEAD has no commits. */
  treeHash: string | null;
  /** The committed range diffed to find the changed files (`main...HEAD`, `a1b2c3d4..HEAD`, `HEAD~1..HEAD`), or null for uncommitted changes only. */
  range: string | null;
  proofBlockPath: string;
  proofBlock: string;
  /** Exactly the line `--hook` prints. */
  summary: string;
}

/** `/manage/invoices/1` -> `manage-invoices-1`; the root route is `root`. Only `[A-Za-z0-9._-]` survive. */
export function routeSlug(route: string): string {
  const slug = route
    .replace(/^\/+|\/+$/g, '')
    .replace(/\//g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 80);
  return slug === '' ? 'root' : slug;
}

const SHORT_TREE = 8;
const EMPTY_GRAPH: ImportGraph = { fileToRoutes: new Map(), routes: [], unresolved: [] };

/** Something is wrong with the setup (not a git repo, ...), as opposed to the proof being incomplete. */
export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

interface State {
  tree: string | null;
  range: string | null;
  failures: string[];
  hints: string[];
  notes: string[];
  routes: RouteProof[];
  expectedCount: number;
  noScreenChanges: boolean;
  truncated: boolean;
  /** Set once the result is final; a late-finishing step must not touch anything after that. */
  closed: boolean;
}

/**
 * Assemble the headline stills and proof block for HEAD. Never launches a browser and does not
 * need the daemon: it reads the timeline the daemon left in the scratch dir.
 */
export async function runFinish(config: Config, opts: FinishOptions = {}): Promise<FinishResult> {
  const dirs = opts.dirs ?? resolveDirs(opts.env);
  ensureDirs(dirs);
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? config.finishBudgetMs;
  const deadline = now() + budgetMs;

  const state: State = {
    tree: null,
    range: null,
    failures: [],
    hints: [],
    notes: [],
    routes: [],
    expectedCount: 0,
    noScreenChanges: false,
    truncated: false,
    closed: false,
  };

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), budgetMs);
  });
  const core = collect(config, dirs, opts, state, deadline, now);
  core.catch(() => {}); // after an expiry its rejection must not go unhandled
  try {
    const outcome = await Promise.race([core.then(() => 'done' as const), expired]);
    if (outcome === 'expired') state.truncated = true;
  } finally {
    clearTimeout(timer);
    state.closed = true;
  }
  if (state.truncated) {
    state.failures.push(
      `truncated: finish budget of ${budgetMs} ms exceeded after ${state.routes.length} of ${state.expectedCount} route(s)`,
    );
  }
  return finalize(dirs, state);
}

async function collect(
  config: Config,
  dirs: Dirs,
  opts: FinishOptions,
  state: State,
  deadline: number,
  now: () => number,
): Promise<void> {
  await gather(config, dirs, opts, state, deadline, now);
  if (!state.closed && state.failures.length > 0) await addHints(config, dirs, state);
}

async function gather(
  config: Config,
  dirs: Dirs,
  opts: FinishOptions,
  state: State,
  deadline: number,
  now: () => number,
): Promise<void> {
  if (!(await isGitRepo(config.repoDir))) throw new SetupError(`${config.repoDir} is not a git repository`);
  if (state.closed) return;
  const tree = await headTree(config.repoDir);
  if (state.closed) return;
  if (tree === null) {
    state.failures.push('HEAD has no commits: commit your changes before running finish');
    return;
  }
  state.tree = tree;

  const status = readStatusFile(statusFiles(dirs).status);
  const { files: changed, range } = await changeSet(config.repoDir, config.baseRef, { anchor: status?.anchor });
  if (state.closed) return;
  state.range = range;
  state.notes.push(`diffed ${describeRange(range)}`);
  const { isScreen, isBackend } = classifier(config);
  const screenFiles = changed.filter((f) => isScreen(f));
  const backendFiles = changed.filter((f) => !isScreen(f) && isBackend(f));
  if (screenFiles.length === 0 && backendFiles.length === 0) {
    state.noScreenChanges = true;
    return;
  }

  let graph = EMPTY_GRAPH;
  let graphFailed = false;
  try {
    graph = await (opts.buildGraph ?? ((c: Config) => buildImportGraph(c)))(config);
  } catch (err) {
    graphFailed = true;
    state.failures.push(`could not build the route graph: ${(err as Error).message.split('\n')[0]}`);
  }
  if (state.closed) return;

  const timeline = new Timeline(dirs.scratchDir, config.maxFrames);
  const expected = new Map<string, RouteProof>();

  const seed = loadRouteParams(config);
  if (seed.error) state.notes.push(`${seed.error}; using routeParams from the config only`);
  for (const warning of seed.warnings) state.notes.push(warning);
  const resolution = resolveRoutes(screenFiles, graph, { ...config, routeParams: seed.params });
  for (const route of resolution.routes) {
    expected.set(route.routeKey, {
      route: route.path,
      routeKey: route.routeKey,
      sourceFiles: route.sourceFiles,
      via: 'screen',
      reasons: [],
    });
  }
  // A changed screen that cannot be tied to a capturable route is unproven, which is a failure, not a note.
  for (const skip of resolution.skipped) {
    if (config.paramSources[skip.routeKey]) {
      // The watcher fills this one from a list endpoint; its frame (or the source error) tells what happened.
      expected.set(skip.routeKey, { route: skip.routeKey, routeKey: skip.routeKey, sourceFiles: skip.sourceFiles, via: 'screen', reasons: [] });
      continue;
    }
    state.failures.push(`cannot capture ${skip.routeKey}: ${skip.reason} (add routeParams)`);
  }
  for (const file of graphFailed ? [] : resolution.unmapped) {
    // (with no graph every file is unmapped; the graph failure above already says why)
    state.failures.push(`no route for ${file} (not reachable from routeFiles; add staticRoutes or ignoreScreenGlobs)`);
  }

  if (backendFiles.length > 0) {
    const knownKeys = new Set([...graph.routes.map((r) => r.path), ...Object.values(config.staticRoutes).flat()]);
    // Only what the current daemon session captured counts; without a session, every frame does.
    const sessionId = typeof status?.sessionId === 'string' && status.sessionId !== '' ? status.sessionId : undefined;
    const captured = new Map<string, string>();
    for (const frame of timeline.list({ sessionId })) captured.set(frame.routeKey, frame.route);
    if (captured.size === 0) {
      state.failures.push(
        `backend change (${backendFiles.join(', ')}) has no captured route to prove; open a page so the watcher captures it, or add staticRoutes`,
      );
    }
    for (const [routeKey, lastRoute] of [...captured].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (expected.has(routeKey)) continue;
      if (!knownKeys.has(routeKey)) {
        state.notes.push(`captured route ${lastRoute} no longer resolves to a route; skipped`);
        continue;
      }
      const concrete = concretePath(routeKey, seed.params);
      if (!concrete.ok && !config.paramSources[routeKey]) {
        state.failures.push(`cannot capture ${routeKey}: ${concrete.reason} (add routeParams)`);
        continue;
      }
      expected.set(routeKey, {
        route: concrete.ok ? concrete.path : routeKey,
        routeKey,
        sourceFiles: backendFiles,
        via: 'backend',
        reasons: [],
      });
    }
  }

  const list = [...expected.values()];
  state.expectedCount = list.length;
  await waitForDaemon({
    config,
    dirs,
    tree,
    list,
    timeline,
    changed,
    state,
    deadline,
    budgetMs: opts.budgetMs ?? config.finishBudgetMs,
    now,
    pollMs: opts.pollMs ?? 200,
  });
  if (state.closed) return;
  const shortTree = tree.slice(0, SHORT_TREE);
  const used = new Set<string>();
  const headlines = new Map<RouteProof, Frame>();
  for (const route of list) {
    if (state.closed) return;
    if (now() >= deadline) {
      state.truncated = true;
      return;
    }
    state.routes.push(route);
    const frame = timeline.latestAtTree(route.route, tree);
    if (!frame) {
      const sourceError = route.route === route.routeKey ? status?.paramSources?.[route.routeKey]?.error : undefined;
      if (sourceError) state.failures.push(`cannot capture ${route.routeKey}: ${sourceError} (add routeParams)`);
      else state.failures.push(`no frame at HEAD for ${route.route}`);
      continue;
    }
    if (route.route === route.routeKey) route.route = frame.route; // filled from a list endpoint: the frame knows the id
    route.status = frame.status;
    route.reasons = frame.reasons;
    route.frameId = frame.id;
    route.sessionId = frame.sessionId;

    const source = timeline.pngPath(frame);
    if (!fs.existsSync(source)) {
      state.failures.push(`frame ${frame.id} for ${route.route} has no PNG on disk (evicted?)`);
      continue;
    }
    let name = `${routeSlug(route.route)}-${shortTree}`;
    for (let n = 2; used.has(name); n++) name = `${routeSlug(route.route)}-${n}-${shortTree}`;
    used.add(name);
    const target = path.join(dirs.artifactDir, `${name}.png`);
    fs.copyFileSync(source, target);
    route.artifact = target;

    if (frame.status !== 'clean') {
      const why = frame.reasons.length > 0 ? `: ${frame.reasons.join('; ')}` : '';
      state.failures.push(`${route.route} final frame is ${frame.status}${why}`);
    } else {
      headlines.set(route, frame);
    }
  }
  if (!state.closed && !state.truncated) checkRendered(config, state, list, headlines);
}

/** Only Vue single-file components carry the `__file` the render check reads. */
const RENDER_CHECKED = /\.vue$/;

/**
 * A clean still proves nothing about a changed component that never made it into the page (behind a `v-if`,
 * or the seeded data does not reach it). For each changed `.vue` screen with routes, at least one of its
 * routes must have a clean headline frame that lists the file among its rendered components. Parents and
 * layouts count: they are in the mounted tree. Frames without the data (production build, non-Vue app, older
 * frames) cannot say either way, so they never fail a file; the skip is noted.
 */
function checkRendered(config: Config, state: State, list: RouteProof[], headlines: Map<RouteProof, Frame>): void {
  if (config.renderCheck === 'off') return;
  const files = new Set<string>();
  for (const route of list) if (route.via === 'screen') for (const f of route.sourceFiles) if (RENDER_CHECKED.test(f)) files.add(f);

  for (const file of [...files].sort()) {
    const routes = list.filter((r) => r.via === 'screen' && r.sourceFiles.includes(file));
    const seen = routes.filter((r) => headlines.has(r));
    if (seen.length === 0) continue; // no clean frame to look at; the failure for that is already recorded
    const known = seen.filter((r) => Array.isArray(headlines.get(r)!.renderedFiles));
    const unknown = seen.filter((r) => !Array.isArray(headlines.get(r)!.renderedFiles));
    const rendered = known.filter((r) => headlines.get(r)!.renderedFiles!.includes(file));

    if (rendered.length > 0) {
      const missing = known.filter((r) => !rendered.includes(r));
      if (missing.length > 0) {
        state.notes.push(`${file} rendered on ${rendered.map((r) => r.route).join(', ')} but not on ${missing.map((r) => r.route).join(', ')}`);
      }
      continue;
    }
    if (unknown.length > 0) {
      state.notes.push(
        `render check skipped for ${file}: no rendered-component data for ${unknown.map((r) => r.route).join(', ')} (production build or not a Vue 3 dev app)`,
      );
      continue;
    }
    const message = `${file} never rendered on ${routes.map((r) => r.route).join(', ')}; seed the state that shows it (RecordsVisualProofRoutes) or add it to ignoreScreenGlobs`;
    if (config.renderCheck === 'warn') state.notes.push(message);
    else state.failures.push(message);
  }
}

/**
 * Remedies for the failures, from what is observable: the watcher's state, why its last capture was
 * refused, whether the commit matches the working tree, and which tree the newest frame is from.
 * The failure strings themselves stay as they are.
 */
async function addHints(config: Config, dirs: Dirs, state: State): Promise<void> {
  const tree = state.tree;
  if (tree === null) return;
  const short = tree.slice(0, SHORT_TREE);
  const hints: string[] = [];
  const status = readStatusFile(statusFiles(dirs).status);
  const live = status !== null && status.state !== 'stopped' && status.state !== 'error' && watcherPid(dirs, status) !== null;
  const noFrame = state.failures.some((f) => f.startsWith('no frame at HEAD for '));

  if (noFrame && !live) {
    hints.push('the watcher is not running, so nothing was captured while you edited: run visual-proof start');
  }
  if (noFrame && typeof status?.lastError === 'string' && status.lastError !== '') {
    hints.push(`the watcher's last capture problem: ${status.lastError}`);
  }
  try {
    const working = await workingTreeHash(config.repoDir, dirs.scratchDir);
    if (working !== tree) {
      hints.push(`working tree (${working.slice(0, SHORT_TREE)}) differs from HEAD (${short}): commit your changes, then rerun finish`);
    }
  } catch {
    // The hint is a convenience; the failures already say what is wrong.
  }
  if (noFrame) {
    const newest = new Timeline(dirs.scratchDir, config.maxFrames).list().at(-1);
    if (newest && newest.treeHash !== tree) {
      hints.push(
        `the newest frame is at tree ${newest.treeHash.slice(0, SHORT_TREE)} but HEAD is ${short}: the committed state was never captured; save the changed files again with the watcher running, then rerun finish`,
      );
    }
  }
  if (!state.closed) state.hints.push(...hints);
}

interface WaitContext {
  config: Config;
  dirs: Dirs;
  tree: string;
  list: RouteProof[];
  timeline: Timeline;
  /** Changed files (config-relative), whose mtimes show edits the daemon may not have heard about yet. */
  changed: string[];
  state: State;
  deadline: number;
  budgetMs: number;
  now: () => number;
  pollMs: number;
}

/** A save this recent may still be on its way through the watcher's debounce, barrier and capture. */
const RECENT_EVENT_MS = 2000;

/**
 * `finish` can run right after the last save and commit, while the watcher is still debouncing,
 * waiting on the HMR barrier or capturing. Reading the timeline then would report "no frame at HEAD"
 * for a frame that is a second away. So while a live daemon is busy (capturing, a batch pending, or
 * a change newer than the last frame it heard about), poll until every expected route has a frame at
 * HEAD's tree or the daemon goes idle, within the finish budget. An idle daemon, or none, means the
 * timeline is final.
 */
async function waitForDaemon(ctx: WaitContext): Promise<void> {
  const { config, dirs, tree, list, timeline, state } = ctx;
  const statusFile = statusFiles(dirs).status;
  // Stop a little before the overall budget so the specific failure below wins over "truncated".
  const waitUntil = ctx.deadline - Math.min(500, ctx.budgetMs * 0.2);
  const startedAt = ctx.now();

  for (;;) {
    if (state.closed) return;
    if (list.every((route) => timeline.latestAtTree(route.route, tree))) return;
    const status = readStatusFile(statusFile);
    if (!status || status.state === 'stopped' || status.state === 'error' || watcherPid(dirs, status) === null) return;
    if (!(await daemonBusy(config, dirs, ctx.changed, status, timeline))) return;
    if (ctx.now() >= waitUntil) {
      const seconds = ((ctx.now() - startedAt) / 1000).toFixed(1);
      state.failures.push(`capture still in progress after ${seconds} s`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, ctx.pollMs));
  }
}

async function daemonBusy(
  config: Config,
  dirs: Dirs,
  changed: string[],
  status: Partial<Status>,
  timeline: Timeline,
): Promise<boolean> {
  if (status.state === 'capturing' || status.pending === true) return true;

  const lastEventAt = status.lastEventAt ? Date.parse(status.lastEventAt) : NaN;
  const recentEvent = Number.isFinite(lastEventAt) && Date.now() - lastEventAt < RECENT_EVENT_MS;
  const unheard = changed.some((file) => {
    try {
      const mtime = fs.statSync(path.join(config.repoDir, file)).mtimeMs;
      return Date.now() - mtime < RECENT_EVENT_MS && !(mtime <= lastEventAt);
    } catch {
      return false; // deleted or unreadable: nothing to hear about
    }
  });
  if (!recentEvent && !unheard) return false;

  // Recent activity only matters while the working tree has moved past what was last captured.
  const newest = timeline.list().at(-1);
  try {
    return (await workingTreeHash(config.repoDir, dirs.scratchDir)) !== newest?.treeHash;
  } catch {
    return false;
  }
}

function finalize(dirs: Dirs, state: State): FinishResult {
  const proofBlockPath = statusFiles(dirs).proofBlock;
  let proofBlock = state.noScreenChanges
    ? `<!-- visual-proof: no screen changes (diffed ${describeRange(state.range)}) -->\n`
    : renderProofBlock(state);
  try {
    writeProofBlock(proofBlockPath, proofBlock);
  } catch (err) {
    // A proof nobody can read is not a proof.
    state.failures.push(`could not write the proof block to ${proofBlockPath}: ${describeError(err)}`);
    proofBlock = renderProofBlock(state);
  }
  const ok = state.failures.length === 0;

  let summary: string;
  if (state.noScreenChanges && ok) summary = 'visual-proof: no screen changes';
  else if (!ok) summary = `visual-proof: ${plural(state.failures.length, 'failure')}, see ${proofBlockPath}`;
  else summary = `visual-proof: ${plural(state.routes.length, 'route')} ok`;

  return {
    ok,
    failures: state.failures,
    hints: state.hints,
    notes: state.notes,
    routes: state.routes,
    noScreenChanges: state.noScreenChanges && ok,
    truncated: state.truncated,
    treeHash: state.tree,
    range: state.range,
    proofBlockPath,
    proofBlock,
    summary,
  };
}

/** Atomic (tmp + rename) so an agent reading the block never sees half of one. */
function writeProofBlock(file: string, content: string): void {
  try {
    writeFileAtomic(file, content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, content);
  }
}

/**
 * The result for a finish that could not even look at the timeline (bad config, not a git repo, an
 * internal error): a failure block is still written, so the proof-block path is always valid.
 */
export function errorResult(dirs: Dirs, failure: string, hints: string[] = []): FinishResult {
  const state: State = {
    tree: null,
    range: null,
    failures: [failure],
    hints,
    notes: [],
    routes: [],
    expectedCount: 0,
    noScreenChanges: false,
    truncated: false,
    closed: true,
  };
  const result = finalize(dirs, state);
  result.summary = `visual-proof: finish error: ${failure}, see ${result.proofBlockPath}`;
  return result;
}

function describeRange(range: string | null): string {
  return range ?? 'uncommitted changes only (no base ref, watcher anchor or parent commit)';
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function renderProofBlock(state: State): string {
  const short = state.tree ? state.tree.slice(0, SHORT_TREE) : 'none';
  const sessions = [...new Set(state.routes.map((r) => r.sessionId).filter((s): s is string => !!s))];
  const lines: string[] = [
    `**Visual proof** · tree \`${short}\` · session ${sessions.length > 0 ? sessions.map((s) => `\`${s}\``).join(', ') : 'none'}`,
  ];

  if (state.failures.length > 0) {
    lines.push('', '**Failures**', '');
    for (const failure of state.failures) lines.push(`- ${failure}`);
    if (state.hints.length > 0) {
      lines.push('', '**Next steps**', '');
      for (const hint of state.hints) lines.push(`- ${hint}`);
    }
  }

  for (const route of state.routes) {
    if (!route.artifact || !route.status) continue;
    lines.push(
      '',
      `<img src="${escapeAttr(route.artifact)}" alt="${escapeAttr(route.route)}">`,
      '',
      `\`${route.route}\` · ${route.status} · tree ${short}`,
    );
  }

  if (state.notes.length > 0) {
    lines.push('', '**Notes**', '');
    for (const note of state.notes) lines.push(`- ${note}`);
  }
  return `${lines.join('\n')}\n`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- status.json / watcher.log ----------------------------------------------

export interface LastFinish {
  at: string;
  ok: boolean;
  failures: string[];
  proofBlockPath: string;
  summary: string;
}

/**
 * Record the outcome for agents that read files, not processes: read-modify-write `lastFinish`
 * into status.json (the daemon's other fields are kept) and append to watcher.log.
 */
export function recordFinish(
  dirs: Dirs,
  result: Pick<FinishResult, 'ok' | 'failures' | 'summary' | 'proofBlockPath'>,
  at = new Date(),
): void {
  const files = statusFiles(dirs);
  const lastFinish: LastFinish = {
    at: at.toISOString(),
    ok: result.ok,
    failures: result.failures,
    proofBlockPath: result.proofBlockPath,
    summary: result.summary,
  };
  try {
    const current: Record<string, unknown> = readStatusFile(files.status) ?? { state: 'stopped' };
    writeFileAtomic(files.status, `${JSON.stringify({ ...current, lastFinish }, null, 2)}\n`);
  } catch {
    // Recording is best-effort; finish's own result is what matters.
  }
  try {
    const stamp = at.toISOString();
    const lines = result.ok
      ? [`${stamp} finish: ${result.summary}`]
      : [`${stamp} finish: ${result.summary}`, ...result.failures.map((f) => `${stamp} finish failure: ${f}`)];
    fs.appendFileSync(files.log, `${lines.join('\n')}\n`);
  } catch {
    // See above.
  }
}

// ---- CLI --------------------------------------------------------------------

export interface FinishCommandContext {
  configPath?: string;
  hook: boolean;
  /** Print the {@link FinishResult} as JSON on stdout instead of the proof block path. */
  json?: boolean;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/**
 * `visual-proof finish [--hook] [--json]`; returns the process exit code: 0 ok, 1 proof failures,
 * 3 setup or config error, 4 internal error (`--hook` always returns 0). Whatever happens, a proof
 * block is written and `lastFinish` recorded.
 */
export async function finishCommand(ctx: FinishCommandContext): Promise<number> {
  const out = ctx.out ?? ((t) => process.stdout.write(t));
  const err = ctx.err ?? ((t) => process.stderr.write(t));
  const dirs = resolveDirs(ctx.env);

  let result: FinishResult;
  let code: number;
  try {
    const cwd = ctx.cwd ?? process.cwd();
    const config = loadConfig({ configPath: path.resolve(cwd, ctx.configPath ?? CONFIG_FILE_NAME), cwd, env: ctx.env });
    result = await runFinish(config, { env: ctx.env, dirs });
    code = result.ok ? EXIT.OK : EXIT.FAILURES;
  } catch (e) {
    const setup = e instanceof ConfigError || e instanceof SetupError;
    try {
      ensureDirs(dirs);
    } catch {
      // writing the block below may then fail too; that is reported by the throw it causes
    }
    result = errorResult(dirs, setup ? describeError(e) : `internal error: ${describeError(e)}`);
    code = setup ? EXIT.SETUP : EXIT.INTERNAL;
  }

  recordFinish(dirs, result);
  if (ctx.hook) {
    out(`${result.summary}\n`);
    return EXIT.OK;
  }
  if (ctx.json) out(`${JSON.stringify(result, null, 2)}\n`);
  else out(`${result.proofBlockPath}\n`);
  if (result.noScreenChanges) err(`visual-proof finish: no screen changes (diffed ${describeRange(result.range)})\n`);
  for (const failure of result.failures) err(`visual-proof finish: ${failure}\n`);
  for (const hint of result.hints) err(`visual-proof finish: hint: ${hint}\n`);
  return code;
}
