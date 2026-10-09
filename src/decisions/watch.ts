import type { Config } from '../config.js';
import type { ImportGraph } from '../resolve/import-graph.js';
import type { RouteResolution } from '../resolve/routes.js';
import { fileDiff } from './diff.js';
import { pruneRoutes } from './prune.js';
import type { DecisionRuntime } from './runtime.js';

/** The watcher never holds a capture longer than this for a prune decision, whatever `decisions.budgetMs` says. */
export const WATCH_PRUNE_BUDGET_MS = 5000;

/**
 * Watch's hook into route pruning: drop the routes of a high fan-out file the text model says the change cannot
 * reach. The decision is cached in the status dir, so `finish` expects exactly the routes that were captured.
 * Any failure keeps every route.
 */
export async function pruneForWatch(
  config: Config,
  runtime: DecisionRuntime,
  statusDir: string,
  files: string[],
  resolution: RouteResolution,
  graph: ImportGraph,
  /** The commit the session started from (`status.anchor`), else `HEAD`. */
  base: string | null,
): Promise<RouteResolution> {
  if (config.decisions.prune === false) return resolution;
  runtime.reset();
  const outcome = await runtime.phase((budget) => {
    if (budget.totalMs > WATCH_PRUNE_BUDGET_MS) budget.capTo(WATCH_PRUNE_BUDGET_MS);
    return pruneRoutes(files, resolution, {
      config: config.decisions,
      client: runtime.client,
      budget,
      statusDir,
      repoDir: config.repoDir,
      graph,
      diffFor: (file) => fileDiff(config.repoDir, base ?? 'HEAD', file),
      log: runtime.log,
    });
  });
  for (const note of outcome.notes) runtime.log?.(`decisions: ${note}`);
  if (outcome.dropped.size === 0) return resolution;
  return {
    ...resolution,
    routes: resolution.routes.filter((r) => !outcome.dropped.has(r.routeKey)),
    skipped: resolution.skipped.filter((r) => !outcome.dropped.has(r.routeKey)),
  };
}
