import path from 'node:path';
import { CONFIG_FILE_NAME, ConfigError, loadConfig, type Config } from './config.js';
import { EXIT } from './exit.js';
import { resolveDirs, statusFiles, type Dirs } from './paths.js';
import { readDiscoveryCache } from './resolve/param-discovery.js';
import { seedCandidates, type SeedCandidate } from './resolve/param-tiers.js';
import { buildImportGraph, type ImportGraph } from './resolve/import-graph.js';
import { buildPath, matchRoute, parseRoutePattern, requiredParams } from './resolve/route-pattern.js';
import { clearSessionParams, readSessionParams, setSessionParams, type SessionEntry } from './resolve/session-params.js';
import { readStatusFile, watcherPid } from './status.js';
import { describeError } from './text.js';
import { Timeline, type Frame } from './timeline.js';

export type ParamsAction = 'set' | 'list' | 'clear';

export const PARAMS_ACTIONS: readonly ParamsAction[] = ['set', 'list', 'clear'];

/** How long `params set` waits for a running watcher to capture the route, unless `--timeout` says otherwise. */
export const DEFAULT_SET_TIMEOUT_S = 20;

export interface ParamsCommandContext {
  configPath?: string;
  action: ParamsAction;
  /** Positional arguments after the action: `[routeKey, key=value...]` for set, `[routeKey?]` for clear. */
  args: string[];
  json: boolean;
  /** `params set`: seconds to wait for the watcher's capture. */
  timeoutSec?: number;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Replaces the import-graph build (tests). */
  buildGraph?: (config: Config) => Promise<ImportGraph>;
  /** How often `set` re-reads `status.json` while waiting. Default 100 ms. */
  pollMs?: number;
}

/**
 * `visual-proof params set|list|clear`. Exit codes: 0 ok; 1 `set` stored the params but the watcher's capture was
 * not clean or did not arrive in time; 2 usage (unknown route key, missing or extra params, a value that does not
 * fit); 3 config error; 4 internal.
 */
export async function paramsCommand(ctx: ParamsCommandContext): Promise<number> {
  const out = ctx.out ?? ((t) => process.stdout.write(t));
  const err = ctx.err ?? ((t) => process.stderr.write(t));
  const dirs = resolveDirs(ctx.env);
  const usage = (message: string): number => {
    err(`visual-proof params ${ctx.action}: ${message}\n`);
    return EXIT.USAGE;
  };

  if (ctx.action === 'list') return listParams(dirs, ctx.json, out);

  const [routeKey, ...rest] = ctx.args;

  if (ctx.action === 'clear') {
    const files = statusFiles(dirs);
    const current = readSessionParams(files.sessionParams);
    if (routeKey !== undefined && !Object.hasOwn(current.routes, routeKey)) {
      // Not set: still a mistake worth catching when the key is not a route at all.
      const known = await routeTable(ctx, err);
      if (typeof known === 'number') return known;
      if (!known.table.includes(routeKey)) return usage(unknownKeyMessage(routeKey, known.table));
      out(`no session params for ${routeKey}\n`);
      return EXIT.OK;
    }
    const { cleared } = clearSessionParams(files.sessionParams, routeKey);
    out(cleared.length === 0 ? 'no session params to clear\n' : `cleared session params for ${cleared.join(', ')}\n`);
    return EXIT.OK;
  }

  // set
  if (routeKey === undefined) return usage("needs a route key and at least one param=value, e.g. params set '/invoices/:id' id=5");
  const values: Record<string, string> = {};
  for (const assignment of rest) {
    const m = /^([A-Za-z_]\w*)=([\s\S]+)$/.exec(assignment);
    if (!m) return usage(`${JSON.stringify(assignment)} is not param=value`);
    if (Object.hasOwn(values, m[1]!)) return usage(`${m[1]} is given twice`);
    values[m[1]!] = m[2]!;
  }

  const known = await routeTable(ctx, err);
  if (typeof known === 'number') return known;
  if (!known.table.includes(routeKey)) return usage(unknownKeyMessage(routeKey, known.table));
  const parsed = parseRoutePattern(routeKey);
  if (!parsed.ok) return usage(`${routeKey} cannot be used: ${parsed.reason}`);
  if (parsed.pattern.params.length === 0) return usage(`${routeKey} has no params to set`);
  const built = buildPath(parsed.pattern, values);
  if (!built.ok) {
    const needed = requiredParams(parsed.pattern);
    return usage(`${built.reason}; usage: params set '${routeKey}' ${(needed.length > 0 ? needed : parsed.pattern.params.map((p) => p.name)).map((n) => `${n}=<value>`).join(' ')}`);
  }

  const files = statusFiles(dirs);
  const entry: SessionEntry = { path: built.path, params: values, at: new Date().toISOString() };
  const rev = setSessionParams(files.sessionParams, routeKey, entry);
  out(`session params set: ${routeKey} -> ${built.path}\n`);

  const status = readStatusFile(files.status);
  const live = status !== null && status.state !== 'stopped' && status.state !== 'error' && watcherPid(dirs, status) !== null;
  if (!live) {
    err(`visual-proof params set: no watcher is running, so nothing was captured; run visual-proof start, then rerun this command\n`);
    return EXIT.OK;
  }
  return waitForCapture(ctx, dirs, known.config, routeKey, built.path, rev, entry.at, out, err);
}

async function waitForCapture(
  ctx: ParamsCommandContext,
  dirs: Dirs,
  cfg: Config,
  routeKey: string,
  routePath: string,
  rev: number,
  setAt: string,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const files = statusFiles(dirs);
  const timeoutMs = (ctx.timeoutSec ?? DEFAULT_SET_TIMEOUT_S) * 1000;
  const pollMs = ctx.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = readStatusFile(files.status);
    if (typeof status?.sessionParamsRev === 'number' && status.sessionParamsRev >= rev) break;
    if (status === null || status.state === 'stopped' || status.state === 'error' || watcherPid(dirs, status) === null) {
      err('visual-proof params set: the watcher stopped before it captured the route\n');
      return EXIT.FAILURES;
    }
    if (Date.now() >= deadline) {
      err(`visual-proof params set: the watcher did not confirm a capture of ${routePath} within ${timeoutMs / 1000} s (see ${files.log})\n`);
      return EXIT.FAILURES;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const frame = latestParamsFrame(new Timeline(dirs.scratchDir, cfg.maxFrames).list(), routeKey, setAt);
  if (!frame) {
    err(`visual-proof params set: the watcher handled the change but took no frame of ${routePath} (see ${files.log})\n`);
    return EXIT.FAILURES;
  }
  out(`captured ${frame.route}: ${frame.status} (frame ${frame.id}, tree ${frame.treeHash.slice(0, 8)})\n`);
  if (frame.status !== 'clean') {
    err(`visual-proof params set: ${frame.route} is ${frame.status}${frame.reasons.length > 0 ? `: ${frame.reasons.join('; ')}` : ''}; check the id, then set it again\n`);
    return EXIT.FAILURES;
  }
  return EXIT.OK;
}

function latestParamsFrame(frames: Frame[], routeKey: string, setAt: string): Frame | undefined {
  return frames.filter((f) => f.routeKey === routeKey && f.trigger === 'params' && f.at >= setAt).at(-1);
}

// ---- list ---------------------------------------------------------------------

export interface DiscoveredEntry {
  routeKey: string;
  path: string;
  foundOn: string;
  at: string;
}

export interface ParamsListing {
  session: Array<{ routeKey: string; path: string; params: Record<string, string>; at: string }>;
  /** Found by link discovery by the running (or last) watcher session. */
  discovered: DiscoveredEntry[];
  seedCandidates: SeedCandidate[];
  files: { session: string; discovery: string };
  /** Problems with the session file, if any. */
  problems: string[];
}

export function listing(dirs: Dirs): ParamsListing {
  const files = statusFiles(dirs);
  const session = readSessionParams(files.sessionParams);
  const status = readStatusFile(files.status);
  const cache = readDiscoveryCache(files.paramDiscovery);
  // Discovered ids belong to one watcher session; another session's file says nothing about the current database.
  const current = cache !== null && typeof status?.sessionId === 'string' && cache.sessionId === status.sessionId ? cache : null;

  const sessionList = Object.entries(session.routes)
    .map(([routeKey, e]) => ({ routeKey, path: e.path, params: e.params, at: e.at }))
    .sort((a, b) => (a.routeKey < b.routeKey ? -1 : 1));
  const discovered = Object.entries(current?.routes ?? {})
    .filter(([routeKey]) => !Object.hasOwn(session.routes, routeKey)) // the session tier wins
    .map(([routeKey, e]) => ({ routeKey, path: e.path, foundOn: e.foundOn, at: e.at }))
    .sort((a, b) => (a.routeKey < b.routeKey ? -1 : 1));
  const candidates = seedCandidates([
    ...sessionList.map((s) => ({ routeKey: s.routeKey, route: s.path, paramsFrom: 'session' as const })),
    ...discovered.map((d) => ({ routeKey: d.routeKey, route: d.path, paramsFrom: 'discovered' as const, paramsFoundOn: d.foundOn })),
  ]);
  return {
    session: sessionList,
    discovered,
    seedCandidates: candidates,
    files: { session: files.sessionParams, discovery: files.paramDiscovery },
    problems: [...(session.error ? [session.error] : []), ...session.warnings],
  };
}

function listParams(dirs: Dirs, json: boolean, out: (text: string) => void): number {
  const result = listing(dirs);
  if (json) {
    out(`${JSON.stringify(result, null, 2)}\n`);
    return EXIT.OK;
  }
  const lines: string[] = [];
  const show = (params: Record<string, string>): string => Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ');
  if (result.session.length > 0) {
    lines.push('session params (set with params set; they outrank every other tier):');
    for (const s of result.session) lines.push(`  ${s.routeKey} -> ${s.path}  (${show(s.params)})`);
  }
  if (result.discovered.length > 0) {
    lines.push('discovered by link discovery this watcher session:');
    for (const d of result.discovered) lines.push(`  ${d.routeKey} -> ${d.path}  (found on ${d.foundOn})`);
  }
  if (result.seedCandidates.length > 0) {
    lines.push("seed candidates (records the app's seeder could create so this needs no param step):");
    for (const c of result.seedCandidates) lines.push(`  ${c.routeKey}  ${show(c.params)}  (${c.paramsFrom}${c.foundOn ? ` on ${c.foundOn}` : ''})`);
  }
  if (lines.length === 0) lines.push('no session or discovered params');
  for (const problem of result.problems) lines.push(`warning: ${problem}`);
  out(`${lines.join('\n')}\n`);
  return EXIT.OK;
}

// ---- route table and suggestions ------------------------------------------------

/** The config and the route keys the app has (the import graph of `routeFiles` plus the `staticRoutes` values); an exit code on a config error. */
async function routeTable(ctx: ParamsCommandContext, err: (text: string) => void): Promise<{ config: Config; table: string[] } | number> {
  let cfg: Config;
  try {
    const cwd = ctx.cwd ?? process.cwd();
    cfg = loadConfig({ configPath: path.resolve(cwd, ctx.configPath ?? CONFIG_FILE_NAME), cwd, env: ctx.env });
  } catch (e) {
    if (e instanceof ConfigError) {
      err(`visual-proof params ${ctx.action}: ${describeError(e)}\n`);
      return EXIT.SETUP;
    }
    throw e;
  }
  let graph: ImportGraph | null = null;
  try {
    graph = await (ctx.buildGraph ?? ((c: Config) => buildImportGraph(c)))(cfg);
  } catch (e) {
    err(`visual-proof params ${ctx.action}: could not build the route table: ${describeError(e)}\n`);
  }
  const table = [...new Set([...(graph?.routes.map((r) => r.path) ?? []), ...Object.values(cfg.staticRoutes).flat()])].sort();
  return { config: cfg, table };
}

/** The exit-2 message for a route key that is not in the table, with the closest keys. */
export function unknownKeyMessage(input: string, table: string[]): string {
  if (table.length === 0) {
    return `${JSON.stringify(input)} is not a known route: the route table is empty (routeFiles found no routes and staticRoutes names none)`;
  }
  const concrete = table.find((key) => matchRoute(key, input) !== null && parseRoutePattern(key).ok);
  const lines = [`${JSON.stringify(input)} is not a known route key`];
  if (concrete !== undefined) {
    const values = matchRoute(concrete, input) ?? {};
    lines.push(`that path fits ${concrete}; use the route key: params set '${concrete}' ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  const close = closestKeys(input, table, 3);
  lines.push(`closest route keys: ${close.join(', ')}`);
  return lines.join('; ');
}

/** The `n` keys closest to `input` by edit distance (case-insensitive). */
export function closestKeys(input: string, keys: string[], n = 3): string[] {
  const lower = input.toLowerCase();
  return keys
    .map((key) => ({ key, distance: editDistance(lower, key.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance || (a.key < b.key ? -1 : 1))
    .slice(0, n)
    .map((x) => x.key);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length]!;
}
