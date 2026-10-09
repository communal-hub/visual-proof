import fs from 'node:fs';
import path from 'node:path';
import type { ImportGraph } from '../resolve/import-graph.js';
import type { RouteResolution } from '../resolve/routes.js';
import { writeFileAtomic } from '../status.js';
import type { DecisionBudget } from './budget.js';
import { noulAnswer, type DecisionsApi } from './client.js';
import type { DecisionsConfig } from './config.js';
import { contentHash } from './diff.js';

/** A route whose probability of being affected is at least this is kept whatever its rank. */
export const KEEP_PROBABILITY = 0.5;
const CACHE_FILE = 'decisions-cache.json';
const CACHE_LIMIT = 200;

/** The decision for one changed file: which of its routes stay in the proof. */
export interface PruneDecision {
  file: string;
  /** Hash of the file content the decision was made for; a different content is a different decision. */
  contentHash: string;
  /** Every route key the file fans out to (the set the decision covers). */
  routes: string[];
  /** Routes the diff touches directly (the page component or a layout): always kept, never asked about. */
  direct: string[];
  /** Probability the change is visible, per route key the model was asked about. */
  probabilities: Record<string, number>;
  kept: string[];
  pruned: string[];
  model: string;
  at: string;
}

export interface PruneContext {
  config: Pick<DecisionsConfig, 'prune' | 'models'>;
  /** Null: only cached decisions apply (no key, decisions off, nothing computed). */
  client: DecisionsApi | null;
  budget: DecisionBudget;
  statusDir: string;
  repoDir: string;
  graph: ImportGraph;
  /** The diff text for one file, computed only on a cache miss. */
  diffFor: (file: string) => Promise<string>;
  log?: (message: string) => void;
}

export interface PruneOutcome {
  /** Route keys to drop from the capture / proof (every file that reaches them pruned them). */
  dropped: Set<string>;
  notes: string[];
  decisions: PruneDecision[];
  /** Files whose decision came from the cache (watch and finish share one set). */
  cached: string[];
}

/**
 * When one changed file fans out to more than `prune.above` routes, ask the text model which of them the change
 * visibly affects, keep the `prune.keep` most likely (and any at 0.5 or more) and drop the rest. Decisions are
 * cached per (file, content hash, route set) in the status dir, so the watcher and `finish` agree on the set
 * without a second request. A cache hit applies even when decisions are off now. A failed request prunes nothing.
 */
export async function pruneRoutes(files: string[], resolution: RouteResolution, ctx: PruneContext): Promise<PruneOutcome> {
  const outcome: PruneOutcome = { dropped: new Set(), notes: [], decisions: [], cached: [] };
  const prune = ctx.config.prune;
  if (prune === false) return outcome;

  const keysByFile = new Map<string, Set<string>>();
  for (const route of [...resolution.routes, ...resolution.skipped]) {
    for (const file of route.sourceFiles) {
      if (!files.includes(file)) continue;
      if (!keysByFile.has(file)) keysByFile.set(file, new Set());
      keysByFile.get(file)!.add(route.routeKey);
    }
  }

  const keptBy = new Map<string, boolean>(); // route key -> some file keeps it
  const touched = new Set<string>(); // route keys that were part of a prune decision
  const cache = new DecisionCache(ctx.statusDir);

  for (const file of [...keysByFile.keys()].sort()) {
    const keys = [...keysByFile.get(file)!].sort();
    for (const key of keys) if (!keptBy.has(key)) keptBy.set(key, false);
    if (keys.length <= prune.above) {
      for (const key of keys) keptBy.set(key, true);
      continue;
    }
    const hash = contentHash(ctx.repoDir, file);
    let decision = hash === null ? undefined : cache.get(file, hash, keys);
    if (decision) outcome.cached.push(file);
    else if (hash !== null && ctx.client) {
      decision = (await decide(file, hash, keys, prune.keep, ctx)) ?? undefined;
      if (decision) cache.put(decision);
    }
    if (!decision) {
      for (const key of keys) keptBy.set(key, true); // no answer: prove everything
      continue;
    }
    outcome.decisions.push(decision);
    for (const key of keys) {
      touched.add(key);
      if (decision.kept.includes(key)) keptBy.set(key, true);
    }
  }

  for (const [key, kept] of keptBy) if (!kept && touched.has(key)) outcome.dropped.add(key);

  for (const decision of outcome.decisions) {
    const gone = decision.pruned.filter((key) => outcome.dropped.has(key));
    if (gone.length === 0) continue;
    const odds = gone.map((key) => `${key} ${(decision.probabilities[key] ?? 0).toFixed(2)}`).join(', ');
    outcome.notes.push(
      `pruned ${gone.length} of ${decision.routes.length} route(s) for ${decision.file}: ${odds} (kept ${decision.kept.join(', ')}); decision by ${decision.model}${outcome.cached.includes(decision.file) ? ' (cached)' : ''}`,
    );
  }
  return outcome;
}

async function decide(file: string, hash: string, keys: string[], keep: number, ctx: PruneContext): Promise<PruneDecision | null> {
  const client = ctx.client!;
  const direct = keys.filter((key) => directlyTouches(ctx.graph, key, file));
  const asked = keys.filter((key) => !direct.includes(key));
  if (asked.length === 0) return null; // everything is the page itself: nothing to prune
  if (ctx.budget.expired()) {
    ctx.log?.(`decisions: prune for ${file} skipped (budget exhausted)`);
    return null;
  }
  const diff = await ctx.diffFor(file);
  const state = {
    file,
    diff,
    routes: keys.map((key) => ({ key, components: componentsChain(ctx.graph, key, file) })),
  };
  const ids = new Map(asked.map((key, i) => [`r${i}`, key]));
  const questions = Object.fromEntries(
    [...ids].map(([id, key]) => [
      id,
      {
        type: 'noul' as const,
        instructions: `Does this change visibly affect what ${key} renders?`,
        criteria: {
          true: 'the diff changes markup, styles or logic of a component on that route (or one it renders)',
          false: 'the diff touches nothing that the route renders',
        },
      },
    ]),
  );
  const call = client.decide({ model: ctx.config.models.text, state, questions, signal: ctx.budget.signal });
  const result = await ctx.budget.race(call);
  if (result === 'timeout' || !result.ok) {
    ctx.log?.(`decisions: prune for ${file} failed: ${result === 'timeout' ? 'budget exhausted' : result.error}`);
    return null;
  }
  const probabilities: Record<string, number> = {};
  for (const [id, key] of ids) {
    const answer = noulAnswer(result, id);
    if (answer) probabilities[key] = clamp01(answer.noul);
  }
  if (Object.keys(probabilities).length !== asked.length) {
    ctx.log?.(`decisions: prune for ${file}: the model answered ${Object.keys(probabilities).length} of ${asked.length} routes; keeping all routes`);
    return null;
  }
  // Rank by probability (route key breaks ties, so the result is stable); keep the top `keep` and anything likely.
  const ranked = [...asked].sort((a, b) => probabilities[b]! - probabilities[a]! || (a < b ? -1 : 1));
  const kept = new Set([...direct, ...ranked.slice(0, keep), ...ranked.filter((key) => probabilities[key]! >= KEEP_PROBABILITY)]);
  return {
    file,
    contentHash: hash,
    routes: keys,
    direct,
    probabilities,
    kept: keys.filter((key) => kept.has(key)),
    pruned: keys.filter((key) => !kept.has(key)),
    model: result.model,
    at: new Date().toISOString(),
  };
}

/** The route's page component or one of its layouts is the changed file itself. */
function directlyTouches(graph: ImportGraph, routeKey: string, file: string): boolean {
  return graph.routes.some((r) => r.path === routeKey && (r.component === file || r.layouts.includes(file)));
}

/** Layouts, the page component and the changed file: what the model reads as "how does this route render the file". */
function componentsChain(graph: ImportGraph, routeKey: string, file: string): string[] {
  const route = graph.routes.find((r) => r.path === routeKey);
  const chain = route ? [...route.layouts.slice().reverse(), ...(route.component ? [route.component] : [])] : [];
  if (!chain.includes(file)) chain.push(file);
  return chain;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

// ---- cache ------------------------------------------------------------------

interface CacheFile {
  version: 1;
  entries: Record<string, PruneDecision>;
}

/** `decisions-cache.json` in the status dir: shared by the watcher and `finish`. Torn or unreadable counts as empty. */
class DecisionCache {
  private readonly file: string;

  constructor(statusDir: string) {
    this.file = path.join(statusDir, CACHE_FILE);
  }

  get(file: string, hash: string, keys: string[]): PruneDecision | undefined {
    const entry = this.read().entries[cacheKey(file, hash)];
    if (!entry || entry.file !== file || entry.contentHash !== hash) return undefined;
    // A different route set (the graph changed) is a different question.
    if (entry.routes.length !== keys.length || entry.routes.some((key, i) => key !== keys[i])) return undefined;
    return entry;
  }

  put(decision: PruneDecision): void {
    const cache = this.read();
    cache.entries[cacheKey(decision.file, decision.contentHash)] = decision;
    const all = Object.entries(cache.entries).sort(([, a], [, b]) => (a.at < b.at ? -1 : 1));
    for (const [key] of all.slice(0, Math.max(0, all.length - CACHE_LIMIT))) delete cache.entries[key];
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, `${JSON.stringify(cache, null, 2)}\n`);
    } catch {
      // A cache that cannot be written only costs a second request.
    }
  }

  private read(): CacheFile {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && (parsed as CacheFile).version === 1 && typeof (parsed as CacheFile).entries === 'object') {
        return parsed as CacheFile;
      }
    } catch {
      // missing or torn
    }
    return { version: 1, entries: {} };
  }
}

function cacheKey(file: string, hash: string): string {
  return `${file}\n${hash}`;
}
