import { API_KEY_ENV } from './client.js';

/**
 * The one model every decision uses, text and images alike (resolves to a dated id such as
 * `typesafe/jev-1.13-20260917`; the answer reports which).
 */
export const DEFAULT_MODEL = 'typesafe/jev-1.13';
export const DEFAULT_BUDGET_MS = 20_000;
export const DEFAULT_PRUNE_ABOVE = 6;
export const DEFAULT_PRUNE_KEEP = 4;

export type TriageMode = 'fail' | 'warn' | 'off';

/** The `decisions` block of the config, with defaults applied. */
export interface DecisionsConfig {
  /** Explicit switch; undefined means "on when an API key exists". `false` never makes a request. */
  enabled?: boolean;
  /** Model id for every decision: image check, claim check, pruning, captions, before/after comparison. */
  model: string;
  /** What a non-clean answer from the image check does: fail finish, add a note, or nothing (and no image requests). */
  triage: TriageMode;
  /** Prune routes when one changed file fans out to more than `above`, keeping the `keep` most likely affected; `false` disables. */
  prune: { above: number; keep: number } | false;
  /** Claim check against `claimFile`; advisory only. */
  verdict: boolean;
  /** Pick a caption for each headline still. */
  captions: boolean;
  /** Time all decisions of one `finish` share. */
  budgetMs: number;
}

export function defaultDecisions(): DecisionsConfig {
  return {
    model: DEFAULT_MODEL,
    triage: 'warn',
    prune: { above: DEFAULT_PRUNE_ABOVE, keep: DEFAULT_PRUNE_KEEP },
    verdict: true,
    captions: true,
    budgetMs: DEFAULT_BUDGET_MS,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate the raw `decisions` value; field-named problems go to `errors`. */
export function parseDecisions(raw: unknown, errors: string[]): DecisionsConfig {
  const out = defaultDecisions();
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    errors.push(`"decisions" must be an object, got ${JSON.stringify(raw)}`);
    return out;
  }
  const bad = (key: string, expected: string, value: unknown): void => {
    errors.push(`"decisions.${key}" must be ${expected}, got ${JSON.stringify(value)}`);
  };
  for (const key of Object.keys(raw)) {
    if (key === 'models') {
      errors.push('"decisions.models" was replaced by "decisions.model": one model (default typesafe/jev-1.13) answers text and image decisions');
    } else if (!['enabled', 'model', 'triage', 'prune', 'verdict', 'captions', 'budgetMs'].includes(key)) {
      errors.push(`"decisions.${key}" is not a known setting (enabled, model, triage, prune, verdict, captions, budgetMs)`);
    }
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    else bad('enabled', 'a boolean', raw.enabled);
  }
  if (raw.model !== undefined) {
    if (typeof raw.model === 'string' && raw.model.trim() !== '') out.model = raw.model.trim();
    else bad('model', 'a non-empty model id', raw.model);
  }
  if (raw.triage !== undefined) {
    if (raw.triage === 'fail' || raw.triage === 'warn' || raw.triage === 'off') out.triage = raw.triage;
    else bad('triage', '"fail", "warn" or "off"', raw.triage);
  }
  if (raw.prune !== undefined) {
    if (raw.prune === false) out.prune = false;
    else if (!isRecord(raw.prune)) bad('prune', 'false or an object { above?, keep? }', raw.prune);
    else {
      const prune = { above: DEFAULT_PRUNE_ABOVE, keep: DEFAULT_PRUNE_KEEP };
      for (const key of ['above', 'keep'] as const) {
        const value = raw.prune[key];
        if (value === undefined) continue;
        if (typeof value === 'number' && Number.isInteger(value) && value >= 1) prune[key] = value;
        else bad(`prune.${key}`, 'a positive integer', value);
      }
      for (const key of Object.keys(raw.prune)) {
        if (key !== 'above' && key !== 'keep') errors.push(`"decisions.prune.${key}" is not a known setting (above, keep)`);
      }
      out.prune = prune;
    }
  }
  for (const key of ['verdict', 'captions'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
    else bad(key, 'a boolean', raw[key]);
  }
  if (raw.budgetMs !== undefined) {
    if (typeof raw.budgetMs === 'number' && Number.isInteger(raw.budgetMs) && raw.budgetMs > 0) out.budgetMs = raw.budgetMs;
    else bad('budgetMs', 'a positive integer', raw.budgetMs);
  }
  return out;
}

/**
 * Whether decisions make requests: on unless `enabled: false`, and only with a key. Without a key the
 * DOM heuristics are all there is (`finish` says so only when `enabled: true` asked for decisions).
 */
export function decisionsActive(config: DecisionsConfig, hasKey: boolean): boolean {
  return config.enabled !== false && hasKey;
}

export function describeMode(config: DecisionsConfig, hasKey: boolean): string {
  if (config.enabled === false) return 'off (decisions.enabled is false)';
  if (!hasKey) return `heuristics only (no ${API_KEY_ENV})`;
  const parts = [
    `triage ${config.triage}`,
    config.prune === false ? 'prune off' : `prune above ${config.prune.above} keep ${config.prune.keep}`,
    `verdict ${config.verdict ? 'on' : 'off'}`,
    `captions ${config.captions ? 'on' : 'off'}`,
    `budget ${config.budgetMs} ms`,
  ];
  return parts.join(', ');
}
