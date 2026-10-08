import type { JsonResponse } from '../browser.js';
import { routeParamNames, type ParamSourceConfig } from '../config.js';
import { firstLine } from '../text.js';

export type { JsonResponse };

/** Fetches an app-relative path with the logged-in browser context (`Capturer.getJson`). */
export type JsonFetcher = (urlPath: string) => Promise<JsonResponse>;

export type PickResult = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Read one value out of decoded JSON. `pick` is either a quoted literal (`'invoices'`, `"x"`) or a dot path whose
 * segments are object keys or array indexes (`data.0.id`, `0.uuid`). The value must be a non-empty string or a
 * finite number; anything else (object, null, boolean, missing) is an error naming the path.
 */
export function pickValue(json: unknown, pick: string): PickResult {
  const literal = /^(['"])(.*)\1$/s.exec(pick);
  if (literal) return literal[2] === '' ? { ok: false, reason: `pick ${pick} is an empty literal` } : { ok: true, value: literal[2]! };

  let current: unknown = json;
  const walked: string[] = [];
  for (const segment of pick.split('.')) {
    if (segment === '') return { ok: false, reason: `pick ${JSON.stringify(pick)} has an empty segment` };
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        return { ok: false, reason: `${at(walked)} is an array but ${JSON.stringify(segment)} is not an index (pick ${JSON.stringify(pick)})` };
      }
      if (Number(segment) >= current.length) {
        return { ok: false, reason: `${at(walked)} has ${current.length} item(s), no index ${segment} (pick ${JSON.stringify(pick)})` };
      }
      current = current[Number(segment)];
    } else if (typeof current === 'object' && current !== null) {
      if (!Object.hasOwn(current, segment)) {
        return { ok: false, reason: `${at(walked)} has no key ${JSON.stringify(segment)} (pick ${JSON.stringify(pick)})` };
      }
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { ok: false, reason: `${at(walked)} is ${describe(current)}, cannot read ${JSON.stringify(segment)} (pick ${JSON.stringify(pick)})` };
    }
    walked.push(segment);
  }
  if (typeof current === 'string' && current !== '') return { ok: true, value: current };
  if (typeof current === 'number' && Number.isFinite(current)) return { ok: true, value: String(current) };
  return { ok: false, reason: `pick ${JSON.stringify(pick)} is ${describe(current)}, expected a string or number` };
}

function at(walked: string[]): string {
  return walked.length === 0 ? 'the response' : walked.join('.');
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return 'an empty string';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** Fill a route key from the response: every `:param` gets its picked value, URL-encoded. */
export function fillRoute(routeKey: string, source: ParamSourceConfig, json: unknown): { ok: true; path: string } | { ok: false; reason: string } {
  const names = routeParamNames(routeKey);
  const picks: Record<string, string> =
    typeof source.pick === 'string' ? { [names[0]!]: source.pick } : source.pick;
  const values: Record<string, string> = {};
  for (const name of names) {
    const picked = pickValue(json, picks[name] ?? '');
    if (!picked.ok) return { ok: false, reason: names.length > 1 ? `param ${name}: ${picked.reason}` : picked.reason };
    values[name] = picked.value;
  }
  return { ok: true, path: routeKey.replace(/:([A-Za-z_]\w*)/g, (_, name: string) => encodeURIComponent(values[name]!)) };
}

export type SourceOutcome = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Third tier of route params: fetch the list endpoint and pick the values. Successes are cached for the session
 * (`invalidate()` drops them, which a backend-triggered recapture does); failures are not, so the next need
 * retries. Concurrent requests for one route key share one fetch.
 */
export class ParamSourceResolver {
  private readonly cache = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<SourceOutcome>>();
  /** Bumped by `invalidate()`: a fetch that started before it must not repopulate the cache with stale data. */
  private generation = 0;

  constructor(
    private readonly sources: Record<string, ParamSourceConfig>,
    private readonly fetchJson: JsonFetcher,
  ) {}

  has(routeKey: string): boolean {
    return Object.hasOwn(this.sources, routeKey);
  }

  invalidate(): void {
    this.cache.clear();
    this.generation++;
  }

  resolve(routeKey: string): Promise<SourceOutcome> {
    const source = this.sources[routeKey];
    if (!source) return Promise.resolve({ ok: false, reason: `no paramSources entry for ${routeKey}` });
    const cached = this.cache.get(routeKey);
    if (cached !== undefined) return Promise.resolve({ ok: true, path: cached });
    let pending = this.inflight.get(routeKey);
    if (!pending) {
      const generation = this.generation;
      pending = this.fetch(routeKey, source, generation).finally(() => this.inflight.delete(routeKey));
      this.inflight.set(routeKey, pending);
    }
    return pending;
  }

  private async fetch(routeKey: string, source: ParamSourceConfig, generation: number): Promise<SourceOutcome> {
    const label = `paramSources ${source.url}`;
    let response: JsonResponse;
    try {
      response = await this.fetchJson(source.url);
    } catch (err) {
      return { ok: false, reason: `${label} failed: ${firstLine(err)}` };
    }
    if (response.error !== undefined) {
      return { ok: false, reason: `${label} failed: ${response.error}` };
    }
    const filled = fillRoute(routeKey, source, response.json);
    if (!filled.ok) return { ok: false, reason: `${label}: ${filled.reason}` };
    if (generation === this.generation) this.cache.set(routeKey, filled.path);
    return filled;
  }
}
