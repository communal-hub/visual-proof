import crypto from 'node:crypto';
import type { FocusConfig } from './config.js';
import { directlyTouches } from './decisions/prune.js';
import type { ImportGraph } from './resolve/import-graph.js';

/** Why a route is a headline (a still in the proof block) rather than an impact route (smoke-checked only). */
export type HeadlineReason = 'claim' | 'page' | 'sidecar' | 'all';

/** What decides the headlines of one change. */
export interface FocusInput {
  focus: FocusConfig;
  /** Screens named by the claim's `<screen>: <what must be visible>` lines. */
  claimScreens: string[];
  graph: ImportGraph;
  /** Changed files (config-relative). */
  changed: string[];
}

/** The part of a route proof focus looks at. */
export interface FocusRoute {
  route: string;
  routeKey: string;
  sourceFiles: string[];
  via: 'screen' | 'backend' | 'sidecar';
  scenario?: { file: string; name: string; still: string };
}

/** A claim screen as written: backticks, a trailing slash and surrounding space do not count. */
export function normalizeScreen(screen: string): string {
  const bare = screen.trim().replace(/^`+|`+$/g, '').trim();
  return bare.length > 1 ? bare.replace(/\/+$/, '') : bare;
}

/** The labels a claim line can use for a route or a sidecar still. */
export function screenLabels(route: FocusRoute): string[] {
  if (route.scenario) {
    const { name, still } = route.scenario;
    return [`sidecar ${name} / ${still}`, `${name} / ${still}`, `sidecar ${name}`, name, still];
  }
  return [route.route, route.routeKey];
}

/** Why `route` is a headline, or null for an impact route. Ignores the fallback; see {@link selectHeadlines}. */
export function headlineReason(route: FocusRoute, input: FocusInput): HeadlineReason | null {
  if (input.focus.mode === 'all') return 'all';
  const claimed = new Set(input.claimScreens.map(normalizeScreen));
  if (screenLabels(route).some((label) => claimed.has(normalizeScreen(label)))) return 'claim';
  if (route.scenario) return input.changed.includes(route.scenario.file) ? 'sidecar' : null;
  if (route.via === 'screen' && route.sourceFiles.some((file) => directlyTouches(input.graph, route.routeKey, file))) return 'page';
  return null;
}

export interface FocusSelection<T> {
  headlines: T[];
  impact: T[];
  reasons: Map<T, HeadlineReason>;
  /** Set when nothing qualified as a headline and every route became one. */
  fallback: boolean;
}

/**
 * Split the expected routes into headlines and impact routes. When no route qualifies as a headline (no claim
 * screen matched, no page changed directly, no sidecar touched), every route is a headline, as before focus existed.
 */
export function selectHeadlines<T extends FocusRoute>(routes: T[], input: FocusInput): FocusSelection<T> {
  const reasons = new Map<T, HeadlineReason>();
  for (const route of routes) {
    const reason = headlineReason(route, input);
    if (reason) reasons.set(route, reason);
  }
  if (reasons.size === 0) {
    for (const route of routes) reasons.set(route, 'all');
    return { headlines: [...routes], impact: [], reasons, fallback: routes.length > 0 && input.focus.mode !== 'all' };
  }
  return { headlines: routes.filter((r) => reasons.has(r)), impact: routes.filter((r) => !reasons.has(r)), reasons, fallback: false };
}

/** Whether a route key or path is named by the claim (unfilled routes are known by key only). */
export function claimNames(key: string, claimScreens: string[]): boolean {
  const target = normalizeScreen(key);
  return claimScreens.some((screen) => normalizeScreen(screen) === target);
}

/** Stable hash of a sidecar's text, kept on its before frames. */
export function scenarioHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** `<screen>: <what must be visible>` lines of the claim, keyed by screen; bullets and numbering are tolerated. */
export function parseExpectations(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const m = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(.+?):\s+(\S.*)$/.exec(raw);
    if (m && !out.has(m[1]!.trim())) out.set(m[1]!.trim(), m[2]!.trim());
  }
  return out;
}
