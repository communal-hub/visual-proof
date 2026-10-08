import type { Config } from '../config.js';
import type { ImportGraph } from './import-graph.js';

export interface ResolvedRoute {
  /** Route pattern, e.g. `/invoices/:id`. */
  routeKey: string;
  /** Concrete path, e.g. `/invoices/1`. */
  path: string;
  /** Absolute URL under `appUrl`. */
  url: string;
  /** Changed source files that led to this route. */
  sourceFiles: string[];
}

export interface SkippedRoute {
  routeKey: string;
  reason: string;
  sourceFiles: string[];
}

export interface RouteResolution {
  routes: ResolvedRoute[];
  skipped: SkippedRoute[];
  /** Files with no route from the import graph or `staticRoutes`; callers log these. */
  unmapped: string[];
}

type RouteConfig = Pick<Config, 'appUrl' | 'staticRoutes' | 'routeParams'>;

/**
 * Chain: import graph, then `staticRoutes` from config, then skip. A file is only looked up
 * in `staticRoutes` when the graph knows nothing about it.
 */
export function resolveRoutes(files: string[], graph: ImportGraph, config: RouteConfig): RouteResolution {
  const sourcesByKey = new Map<string, Set<string>>();
  const unmapped: string[] = [];

  for (const file of files) {
    const keys = graph.fileToRoutes.get(file) ?? config.staticRoutes[file] ?? [];
    if (keys.length === 0) unmapped.push(file);
    for (const key of keys) {
      if (!sourcesByKey.has(key)) sourcesByKey.set(key, new Set());
      sourcesByKey.get(key)!.add(file);
    }
  }

  const routes: ResolvedRoute[] = [];
  const skipped: SkippedRoute[] = [];
  for (const [routeKey, sources] of [...sourcesByKey].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const sourceFiles = [...sources].sort();
    const concrete = concretePath(routeKey, config.routeParams);
    if (concrete.ok) {
      routes.push({ routeKey, path: concrete.path, url: joinUrl(config.appUrl, concrete.path), sourceFiles });
    } else {
      skipped.push({ routeKey, reason: concrete.reason, sourceFiles });
    }
  }
  return { routes, skipped, unmapped };
}

/** Apply `routeParams` to a route pattern; patterns with unfilled params are not capturable. */
export function concretePath(
  routeKey: string,
  routeParams: Record<string, string>,
): { ok: true; path: string } | { ok: false; reason: string } {
  const override = routeParams[routeKey];
  if (override !== undefined) return { ok: true, path: override };

  const params = routeKey.match(/:[A-Za-z_]\w*/g);
  if (params) {
    return { ok: false, reason: `no routeParams entry for ${routeKey} (params: ${params.join(', ')})` };
  }
  return { ok: true, path: routeKey };
}

export function joinUrl(appUrl: string, routePath: string): string {
  return appUrl.replace(/\/+$/, '') + (routePath.startsWith('/') ? routePath : `/${routePath}`);
}
