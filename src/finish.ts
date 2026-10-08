import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE_NAME, loadConfig, type Config } from './config.js';
import { changeSet, headTree, workingTreeHash } from './git.js';
import { classifier } from './globs.js';
import { ensureDirs, resolveDirs, statusFiles, type Dirs } from './paths.js';
import { buildImportGraph, type ImportGraph } from './resolve/import-graph.js';
import { concretePath, resolveRoutes } from './resolve/routes.js';
import { readStatusFile, watcherPid, type Status } from './status.js';
import { Timeline } from './timeline.js';
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

interface State {
  tree: string | null;
  range: string | null;
  failures: string[];
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
  return finalize(config, dirs, state);
}

async function collect(
  config: Config,
  dirs: Dirs,
  opts: FinishOptions,
  state: State,
  deadline: number,
  now: () => number,
): Promise<void> {
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

  const resolution = resolveRoutes(screenFiles, graph, config);
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
      const concrete = concretePath(routeKey, config.routeParams);
      if (!concrete.ok) {
        state.failures.push(`cannot capture ${routeKey}: ${concrete.reason} (add routeParams)`);
        continue;
      }
      expected.set(routeKey, {
        route: concrete.path,
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
  for (const route of list) {
    if (state.closed) return;
    if (now() >= deadline) {
      state.truncated = true;
      return;
    }
    state.routes.push(route);
    const frame = timeline.latestAtTree(route.route, tree);
    if (!frame) {
      state.failures.push(`no frame at HEAD for ${route.route}`);
      continue;
    }
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
    }
  }
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

function finalize(config: Config, dirs: Dirs, state: State): FinishResult {
  const proofBlockPath = statusFiles(dirs).proofBlock;
  const proofBlock = state.noScreenChanges
    ? `<!-- visual-proof: no screen changes (diffed ${describeRange(state.range)}) -->\n`
    : renderProofBlock(state);
  fs.writeFileSync(proofBlockPath, proofBlock);

  const ok = state.failures.length === 0;
  let summary: string;
  if (state.noScreenChanges && ok) summary = 'visual-proof: no screen changes';
  else if (!ok) summary = `visual-proof: ${plural(state.failures.length, 'failure')}, see ${proofBlockPath}`;
  else summary = `visual-proof: ${plural(state.routes.length, 'route')} ok`;

  return {
    ok,
    failures: state.failures,
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
}

/**
 * Record the outcome for agents that read files, not processes: read-modify-write `lastFinish`
 * into status.json (the daemon's other fields are kept) and append to watcher.log.
 */
export function recordFinish(dirs: Dirs, result: Pick<FinishResult, 'ok' | 'failures' | 'summary'>, at = new Date()): void {
  const files = statusFiles(dirs);
  const lastFinish: LastFinish = { at: at.toISOString(), ok: result.ok, failures: result.failures };
  try {
    let current: Record<string, unknown> = { state: 'stopped' };
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(files.status, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // No status file yet (daemon never ran) or a torn one: start from a stopped stub.
    }
    const tmp = `${files.status}.${process.pid}.finish.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ ...current, lastFinish }, null, 2)}\n`);
    fs.renameSync(tmp, files.status);
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
  env: NodeJS.ProcessEnv;
  cwd?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** `visual-proof finish [--hook]`; returns the process exit code. */
export async function finishCommand(ctx: FinishCommandContext): Promise<number> {
  const out = ctx.out ?? ((t) => process.stdout.write(t));
  const err = ctx.err ?? ((t) => process.stderr.write(t));
  const dirs = resolveDirs(ctx.env);
  const oneLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'unknown error';

  let result: FinishResult;
  try {
    const cwd = ctx.cwd ?? process.cwd();
    const config = loadConfig({ configPath: path.resolve(cwd, ctx.configPath ?? CONFIG_FILE_NAME), cwd, env: ctx.env });
    result = await runFinish(config, { env: ctx.env, dirs });
  } catch (e) {
    const failure = `finish error: ${oneLine(e)}`;
    if (!ctx.hook) {
      err(`visual-proof finish: ${oneLine(e)}\n`);
      return 1;
    }
    try {
      ensureDirs(dirs);
    } catch {
      // fall through; recordFinish is best-effort
    }
    const summary = `visual-proof: ${failure}, see ${statusFiles(dirs).log}`;
    recordFinish(dirs, { ok: false, failures: [failure], summary });
    out(`${summary}\n`);
    return 0;
  }

  recordFinish(dirs, result);
  if (ctx.hook) {
    out(`${result.summary}\n`);
    return 0;
  }
  if (result.noScreenChanges) {
    out('no screen changes\n');
    return 0;
  }
  out(`${result.proofBlockPath}\n`);
  for (const failure of result.failures) err(`visual-proof finish: ${failure}\n`);
  return result.ok ? 0 : 1;
}
