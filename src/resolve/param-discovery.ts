import type { LinkPage } from '../browser.js';
import { readJsonObject, writeFileAtomic } from '../status.js';
import { firstLine } from '../text.js';
import { buildPath, matchRoute, moreSpecificRoute, nearestParent, normalizePathname, parseRoutePattern } from './route-pattern.js';

/** How many ancestors a route may need filled, one below the other, before discovery gives up. */
export const MAX_DISCOVERY_DEPTH = 3;

export type { LinkPage };

export type CollectLinks = (url: string) => Promise<LinkPage>;

export type DiscoveryOutcome =
  | { ok: true; path: string; foundOn: string; ms: number; cached: boolean }
  | { ok: false; reason: string; ms: number };

/** The result of filling an ancestor route through every tier (the parent may itself have been discovered). */
export type ParentFill = { ok: true; path: string } | { ok: false; reason: string };

export interface DiscoveryDeps {
  appUrl: string;
  collect: CollectLinks;
  /** Every route key the app knows (import graph and `staticRoutes`). */
  routes: () => Promise<string[]>;
  /** Fill an ancestor that has params through all tiers; `depth` is the ancestor's depth (the target is 0). */
  fillParent: (routeKey: string, depth: number) => Promise<ParentFill>;
  /** Called after every change of the cache, to mirror it into the status dir. */
  onCacheChange?: (entries: Record<string, CachedDiscovery>) => void;
  log?: (message: string) => void;
}

export interface CachedDiscovery {
  path: string;
  foundOn: string;
  at: string;
}

export interface LinkChoice {
  path?: string;
  /** Candidates that fit the pattern but are really a more specific route (`/invoices/create`). */
  skipped: Array<{ path: string; route: string }>;
  /** Same-origin paths seen, to tell "no links at all" from "none fit". */
  sameOrigin: number;
}

/**
 * The first link, in DOM order, that is same-origin, normalised to a path (query, hash and trailing slash
 * dropped, the app's base path removed) and fits the route pattern, skipping paths that really belong to a more
 * specific route.
 */
export function chooseLink(hrefs: string[], routeKey: string, appUrl: string, knownRoutes: string[]): LinkChoice {
  const choice: LinkChoice = { skipped: [], sameOrigin: 0 };
  let app: URL;
  try {
    app = new URL(appUrl);
  } catch {
    return choice;
  }
  const base = app.pathname.replace(/\/+$/, '');
  for (const href of hrefs) {
    let url: URL;
    try {
      url = new URL(href, app);
    } catch {
      continue;
    }
    if (url.origin !== app.origin) continue;
    let pathname = url.pathname;
    if (base !== '') {
      if (pathname !== base && !pathname.startsWith(`${base}/`)) continue;
      pathname = pathname.slice(base.length) || '/';
    }
    const path = normalizePathname(pathname);
    choice.sameOrigin++;
    if (matchRoute(routeKey, path) === null) continue;
    const specific = moreSpecificRoute(routeKey, path, knownRoutes);
    if (specific) {
      if (!choice.skipped.some((s) => s.path === path)) choice.skipped.push({ path, route: specific });
      continue;
    }
    choice.path = path;
    return choice;
  }
  return choice;
}

/**
 * Link discovery: the last tier of route params. For a route with unfilled params it loads the nearest parent
 * route (`/invoices/:id` -> `/invoices`) in the logged-in browser and takes the first link that fits the route's
 * pattern. A parent with params of its own is filled through `deps.fillParent` (which may discover it in turn),
 * to a depth of {@link MAX_DISCOVERY_DEPTH}.
 *
 * Successes are cached per watcher session (`invalidate()` drops them: a backend change may re-seed the ids);
 * failures are not, so the next need retries. Concurrent requests for one route key share one lookup.
 */
export class ParamDiscoverer {
  private readonly cache = new Map<string, CachedDiscovery>();
  private readonly inflight = new Map<string, Promise<DiscoveryOutcome>>();
  /** Bumped by `invalidate()`: a lookup that started before it must not repopulate the cache with stale ids. */
  private generation = 0;

  constructor(private readonly deps: DiscoveryDeps) {}

  invalidate(): void {
    this.cache.clear();
    this.generation++;
    this.deps.onCacheChange?.({});
  }

  entries(): Record<string, CachedDiscovery> {
    return Object.fromEntries(this.cache);
  }

  discover(routeKey: string, depth = 0): Promise<DiscoveryOutcome> {
    const cached = this.cache.get(routeKey);
    if (cached) return Promise.resolve({ ok: true, path: cached.path, foundOn: cached.foundOn, ms: 0, cached: true });
    let pending = this.inflight.get(routeKey);
    if (!pending) {
      const generation = this.generation;
      pending = this.run(routeKey, depth, generation).finally(() => this.inflight.delete(routeKey));
      this.inflight.set(routeKey, pending);
    }
    return pending;
  }

  private async run(routeKey: string, depth: number, generation: number): Promise<DiscoveryOutcome> {
    const started = Date.now();
    const fail = (reason: string): DiscoveryOutcome => ({ ok: false, reason, ms: Date.now() - started });

    const parsed = parseRoutePattern(routeKey);
    if (!parsed.ok) return fail(`route pattern not supported: ${parsed.reason}`);
    let known: string[];
    try {
      known = await this.deps.routes();
    } catch (err) {
      return fail(`route table unavailable: ${firstLine(err)}`);
    }
    const parentKey = nearestParent(routeKey, known);
    if (parentKey === null) return fail(`no parent route for ${routeKey}`);

    let parentPath: string;
    const direct = buildPath(parentKey, {});
    if (direct.ok) {
      parentPath = direct.path;
    } else {
      if (depth >= MAX_DISCOVERY_DEPTH) {
        return fail(`parent ${parentKey} needs params and the discovery depth limit (${MAX_DISCOVERY_DEPTH}) is reached`);
      }
      const filled = await this.deps.fillParent(parentKey, depth + 1);
      if (!filled.ok) return fail(`parent ${parentKey} has no params: ${filled.reason}`);
      parentPath = filled.path;
    }

    let page: LinkPage;
    try {
      page = await this.deps.collect(joinAppUrl(this.deps.appUrl, parentPath));
    } catch (err) {
      return fail(`could not load ${parentPath}: ${firstLine(err)}`);
    }
    if (!page.ok) return fail(`could not load ${parentPath}: ${page.error ?? 'no answer'}`);

    const choice = chooseLink(page.hrefs, routeKey, this.deps.appUrl, known);
    if (choice.path === undefined) {
      const notes: string[] = [];
      if (choice.skipped.length > 0) {
        notes.push(`skipped ${choice.skipped.slice(0, 3).map((s) => `${s.path} (route ${s.route})`).join(', ')}`);
      }
      if (page.hrefs.length === 0) notes.push('the page has no links');
      const landed = landedPath(page.finalUrl, this.deps.appUrl);
      if (landed !== null && landed !== parentPath) notes.push(`the page ended on ${landed}`);
      return fail(`no link matching ${routeKey} on ${parentPath}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`);
    }

    const ms = Date.now() - started;
    if (generation === this.generation) {
      this.cache.set(routeKey, { path: choice.path, foundOn: parentPath, at: new Date().toISOString() });
      this.deps.onCacheChange?.(this.entries());
    }
    this.deps.log?.(`param discovery: ${routeKey} -> ${choice.path} (found on ${parentPath}, ${ms} ms)`);
    return { ok: true, path: choice.path, foundOn: parentPath, ms, cached: false };
  }
}

function joinAppUrl(appUrl: string, routePath: string): string {
  return appUrl.replace(/\/+$/, '') + (routePath.startsWith('/') ? routePath : `/${routePath}`);
}

function landedPath(finalUrl: string | undefined, appUrl: string): string | null {
  if (!finalUrl) return null;
  try {
    const app = new URL(appUrl);
    const url = new URL(finalUrl);
    if (url.origin !== app.origin) return null;
    const base = app.pathname.replace(/\/+$/, '');
    const pathname = base !== '' && url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length) : url.pathname;
    return normalizePathname(pathname);
  } catch {
    return null;
  }
}

// ---- cache file --------------------------------------------------------------

/** `<statusDir>/param-discovery.json`: what link discovery found in one watcher session (read by `params list`). */
export interface DiscoveryCacheFile {
  sessionId: string;
  routes: Record<string, CachedDiscovery>;
}

export function writeDiscoveryCache(file: string, sessionId: string, routes: Record<string, CachedDiscovery>): void {
  try {
    writeFileAtomic(file, `${JSON.stringify({ version: 1, sessionId, routes }, null, 2)}\n`);
  } catch {
    // A convenience mirror; the status dir may be gone (tests cleaning up).
  }
}

/** The cache file, or null when it is missing or torn. */
export function readDiscoveryCache(file: string): DiscoveryCacheFile | null {
  const raw = readJsonObject(file);
  if (!raw || typeof raw.sessionId !== 'string' || typeof raw.routes !== 'object' || raw.routes === null || Array.isArray(raw.routes)) return null;
  const routes: Record<string, CachedDiscovery> = {};
  for (const [key, value] of Object.entries(raw.routes as Record<string, unknown>)) {
    const v = value as Partial<CachedDiscovery> | null;
    if (v && typeof v.path === 'string' && typeof v.foundOn === 'string') {
      routes[key] = { path: v.path, foundOn: v.foundOn, at: typeof v.at === 'string' ? v.at : '' };
    }
  }
  return { sessionId: raw.sessionId, routes };
}
