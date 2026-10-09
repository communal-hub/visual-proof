import type { ParamsFrom } from '../timeline.js';
import type { SourceOutcome } from './param-sources.js';
import type { DiscoveryOutcome, ParamDiscoverer } from './param-discovery.js';
import type { LayeredParams } from './param-tiers.js';

export type FillOutcome =
  | { ok: true; path: string; from: ParamsFrom; foundOn?: string; discoveryMs?: number }
  | { ok: false; reason: string };

export interface FillDeps {
  /** The session, seed-file and config tiers, re-read on every call. */
  layered: () => LayeredParams;
  hasSource: (routeKey: string) => boolean;
  /** Fetch from the route's `paramSources` entry (the watcher records the outcome in `status.json`). */
  fromSource: (routeKey: string) => Promise<SourceOutcome>;
  /** Null when link discovery is off or the capturer cannot collect links. */
  discoverer: ParamDiscoverer | null;
  /** Called for every discovery attempt, parents included, so the watcher can log it and record it in `status.json`. */
  onDiscovery?: (routeKey: string, outcome: DiscoveryOutcome) => void;
}

/**
 * Fills a route key's params from the first tier that has them:
 * session > routeParamsFile > routeParams > paramSources > link discovery.
 * The watcher calls it for routes the cheap tiers left unfilled, and discovery calls it back (`fill` with a depth)
 * for a parent route that has params of its own.
 */
export class ParamFiller {
  constructor(private readonly deps: FillDeps) {}

  /** Some tier beyond the cheap ones could fill this route (a list endpoint, or discovery). */
  canFill(routeKey: string): boolean {
    return this.deps.hasSource(routeKey) || this.deps.discoverer !== null;
  }

  async fill(routeKey: string, depth = 0): Promise<FillOutcome> {
    const layered = this.deps.layered();
    const known = layered.params[routeKey];
    if (known !== undefined) return { ok: true, path: known, from: layered.origin[routeKey] ?? 'config' };

    const reasons: string[] = [];
    if (this.deps.hasSource(routeKey)) {
      const outcome = await this.deps.fromSource(routeKey);
      if (outcome.ok) return { ok: true, path: outcome.path, from: 'source' };
      reasons.push(outcome.reason);
    }
    const discoverer = this.deps.discoverer;
    if (discoverer) {
      const outcome = await discoverer.discover(routeKey, depth);
      this.deps.onDiscovery?.(routeKey, outcome);
      if (outcome.ok) return { ok: true, path: outcome.path, from: 'discovered', foundOn: outcome.foundOn, discoveryMs: outcome.ms };
      reasons.push(`discovery: ${outcome.reason}`);
    }
    return { ok: false, reason: reasons.length > 0 ? reasons.join('; ') : `no params for ${routeKey}` };
  }
}
