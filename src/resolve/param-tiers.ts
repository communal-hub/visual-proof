import type { Config } from '../config.js';
import type { Status } from '../status.js';
import type { ParamsFrom } from '../timeline.js';
import { loadRouteParams, type RouteParams } from './route-params.js';
import { matchRoute, parseRoutePattern } from './route-pattern.js';
import { readSessionParams, type SessionParams } from './session-params.js';

/**
 * The tiers that need no browser and no list endpoint, merged: session params (`visual-proof params set`) over
 * `routeParamsFile` over `routeParams`. Precedence of all tiers, first match wins:
 * session > routeParamsFile > routeParams > paramSources > link discovery. (The seed file has always overridden
 * `routeParams`; v0.8 keeps that and puts the session on top.)
 */
export interface LayeredParams {
  /** Route key -> concrete path, ready for `concretePath` / `resolveRoutes`. */
  params: Record<string, string>;
  /** Which of the three tiers each key in `params` came from. */
  origin: Record<string, Extract<ParamsFrom, 'session' | 'config' | 'file'>>;
  seed: RouteParams;
  session: SessionParams;
  /** Problems with the seed file or the session file, for the log (once per distinct set) and the finish notes. */
  problems: string[];
}

export function layerParams(seed: RouteParams, session: SessionParams): LayeredParams {
  const params: Record<string, string> = { ...seed.params };
  const origin: LayeredParams['origin'] = {};
  const fileKeys = new Set(seed.fileKeys);
  for (const key of Object.keys(seed.params)) origin[key] = fileKeys.has(key) ? 'file' : 'config';
  for (const [key, entry] of Object.entries(session.routes)) {
    params[key] = entry.path;
    origin[key] = 'session';
  }
  const problems = [
    ...(seed.error ? [seed.error] : []),
    ...seed.warnings,
    ...(session.error ? [session.error] : []),
    ...session.warnings,
  ];
  return { params, origin, seed, session, problems };
}

/** Read the seed file and the session file and merge them. Never throws; both files are re-read on every call. */
export function loadLayeredParams(config: Pick<Config, 'repoDir' | 'routeParams' | 'routeParamsFile'>, sessionFile: string): LayeredParams {
  return layerParams(loadRouteParams(config), readSessionParams(sessionFile));
}

// ---- unfilled routes ---------------------------------------------------------

export type TierName = 'session' | 'routeParams' | 'routeParamsFile' | 'paramSources' | 'discovery';

/** What one tier did for a route that stayed unfilled. */
export interface TierTrial {
  tier: TierName;
  /** False when the tier could not have applied (not configured, switched off, watcher not running). */
  tried: boolean;
  reason: string;
}

/** A route `finish` could not capture because nothing filled its params, with the exact way out. */
export interface UnfilledRoute {
  routeKey: string;
  /** The param names `params set` needs. */
  params: string[];
  /** The command that fixes it, e.g. `npx visual-proof params set '/invoices/:id' id=<value>`. */
  command: string;
  /** Create a record first when none exists. */
  advice: string;
  tiers: TierTrial[];
}

export const CREATE_RECORD_ADVICE = "If no record exists, create one first (e.g. with the app's factories or seeders) and use its id.";

/** `npx visual-proof params set '<routeKey>' <param>=<value> ...`, with the key shell-quoted. */
export function setCommand(routeKey: string, params: string[]): string {
  const quoted = `'${routeKey.replace(/'/g, "'\\''")}'`;
  return `npx visual-proof params set ${quoted}${params.map((p) => ` ${p}=<value>`).join('')}`;
}

export interface ExplainInput {
  routeKey: string;
  config: Pick<Config, 'routeParams' | 'routeParamsFile' | 'paramSources' | 'paramDiscovery'>;
  layered: Pick<LayeredParams, 'seed' | 'session'>;
  status: Partial<Status> | null;
  /** A watcher process is alive (it would have tried discovery on its own). */
  watcherLive: boolean;
}

export function explainUnfilled(input: ExplainInput): UnfilledRoute {
  const { routeKey, config, layered, status } = input;
  const parsed = parseRoutePattern(routeKey);
  const all = parsed.ok ? parsed.pattern.params : [];
  const required = all.filter((p) => !p.optional);
  const names = (required.length > 0 ? required : all).map((p) => p.name);

  const tiers: TierTrial[] = [];
  tiers.push({ tier: 'session', tried: true, reason: layered.session.error ? `unreadable (${layered.session.error})` : 'none set' });
  tiers.push({ tier: 'routeParams', tried: true, reason: 'no entry' });
  if (!config.routeParamsFile) tiers.push({ tier: 'routeParamsFile', tried: false, reason: 'not configured' });
  else if (layered.seed.error) tiers.push({ tier: 'routeParamsFile', tried: true, reason: layered.seed.error });
  else if (layered.seed.missing) tiers.push({ tier: 'routeParamsFile', tried: true, reason: `file not found: ${config.routeParamsFile}` });
  else tiers.push({ tier: 'routeParamsFile', tried: true, reason: 'no entry' });

  if (!Object.hasOwn(config.paramSources, routeKey)) tiers.push({ tier: 'paramSources', tried: false, reason: 'not configured' });
  else {
    const error = status?.paramSources?.[routeKey]?.error;
    tiers.push({ tier: 'paramSources', tried: error !== undefined, reason: error ?? 'not attempted' });
  }

  if (config.paramDiscovery === 'off') tiers.push({ tier: 'discovery', tried: false, reason: 'off (paramDiscovery: "off")' });
  else {
    const error = status?.paramDiscovery?.[routeKey]?.error;
    if (error !== undefined) tiers.push({ tier: 'discovery', tried: true, reason: error });
    else tiers.push({ tier: 'discovery', tried: false, reason: input.watcherLive ? 'not attempted' : 'not attempted (the watcher is not running)' });
  }
  return { routeKey, params: names, command: setCommand(routeKey, names), advice: CREATE_RECORD_ADVICE, tiers };
}

/** The `finish` failure for an unfilled route: what was tried, then the command and the advice. */
export function unfilledMessage(u: UnfilledRoute): string {
  // A reason that already names its tier (`paramSources /api/x failed: ...`) is not prefixed twice.
  const tried = u.tiers.map((t) => (t.reason.startsWith(t.tier) ? t.reason : `${t.tier}: ${t.reason}`)).join('; ');
  return `cannot capture ${u.routeKey}: params unfilled. Tried: ${tried}. Fix: ${u.command}. ${u.advice}`;
}

// ---- provenance --------------------------------------------------------------

/** A route whose params the agent set or the watcher discovered: likely something the app's seeder should provide. */
export interface SeedCandidate {
  routeKey: string;
  /** The concrete path that was captured. */
  route: string;
  /** The param values taken out of `route` by the route's pattern. */
  params: Record<string, string>;
  paramsFrom: Extract<ParamsFrom, 'session' | 'discovered'>;
  /** With `discovered`: the page whose links gave the id. */
  foundOn?: string;
}

export function seedCandidates(routes: Array<{ routeKey: string; route: string; paramsFrom?: ParamsFrom; paramsFoundOn?: string }>): SeedCandidate[] {
  const out: SeedCandidate[] = [];
  const seen = new Set<string>();
  for (const r of routes) {
    if (r.paramsFrom !== 'session' && r.paramsFrom !== 'discovered') continue;
    if (seen.has(r.routeKey)) continue;
    seen.add(r.routeKey);
    out.push({
      routeKey: r.routeKey,
      route: r.route,
      params: matchRoute(r.routeKey, r.route) ?? {},
      paramsFrom: r.paramsFrom,
      ...(r.paramsFrom === 'discovered' && r.paramsFoundOn ? { foundOn: r.paramsFoundOn } : {}),
    });
  }
  return out.sort((a, b) => (a.routeKey < b.routeKey ? -1 : a.routeKey > b.routeKey ? 1 : 0));
}
