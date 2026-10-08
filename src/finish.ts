import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { CONFIG_FILE_NAME, loadConfig, type Config } from './config.js';
import { changedFiles, headTree } from './git.js';
import { ensureDirs, resolveDirs, statusFiles, type Dirs } from './paths.js';
import { buildImportGraph, type ImportGraph } from './resolve/import-graph.js';
import { concretePath, resolveRoutes } from './resolve/routes.js';
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

  const changed = await changedFiles(config.repoDir, config.baseRef);
  if (state.closed) return;
  const isScreen = picomatch(config.screenGlobs, { dot: true });
  const isBackend = picomatch(config.backendGlobs, { dot: true });
  const screenFiles = changed.filter((f) => isScreen(f));
  const backendFiles = changed.filter((f) => !isScreen(f) && isBackend(f));
  if (screenFiles.length === 0 && backendFiles.length === 0) {
    state.noScreenChanges = true;
    return;
  }

  let graph = EMPTY_GRAPH;
  try {
    graph = await (opts.buildGraph ?? ((c: Config) => buildImportGraph(c)))(config);
  } catch (err) {
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
  for (const skip of resolution.skipped) {
    state.notes.push(`skipped ${skip.routeKey}: ${skip.reason} (from ${skip.sourceFiles.join(', ')})`);
  }
  for (const file of resolution.unmapped) state.notes.push(`no route for ${file}`);

  if (backendFiles.length > 0) {
    const knownKeys = new Set([...graph.routes.map((r) => r.path), ...Object.values(config.staticRoutes).flat()]);
    const captured = new Map<string, string>();
    for (const frame of timeline.list()) captured.set(frame.routeKey, frame.route);
    if (captured.size === 0) {
      state.notes.push(`backend change (${backendFiles.join(', ')}) but no route was ever captured, so there is nothing to prove`);
    }
    for (const [routeKey, lastRoute] of [...captured].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (expected.has(routeKey)) continue;
      if (!knownKeys.has(routeKey)) {
        state.notes.push(`captured route ${lastRoute} no longer resolves to a route; skipped`);
        continue;
      }
      const concrete = concretePath(routeKey, config.routeParams);
      if (!concrete.ok) {
        state.notes.push(`skipped ${routeKey}: ${concrete.reason}`);
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

function finalize(config: Config, dirs: Dirs, state: State): FinishResult {
  const proofBlockPath = statusFiles(dirs).proofBlock;
  const proofBlock = state.noScreenChanges ? '<!-- visual-proof: no screen changes -->\n' : renderProofBlock(state);
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
    proofBlockPath,
    proofBlock,
    summary,
  };
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
