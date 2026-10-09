import { API_KEY_ENV, DecisionsClient, choiceAnswer, imageState, noulAnswer, loadApiKey, type DecisionsApi } from './client.js';
import { describeMode, type DecisionsConfig } from './config.js';

/** Result of one cheap probe of one model. */
export interface ModelProbe {
  /** The id the request asked for. */
  model: string;
  ok: boolean;
  /** The id the provider resolved it to (`typesafe/jev-1.13` -> `typesafe/jev-1.13-20260917`). */
  resolved?: string;
  ms: number;
  error?: string;
}

export interface DecisionsProbe {
  triage: ModelProbe;
  text: ModelProbe;
}

/** A 1x1 white PNG: the cheapest image that still goes through the image encoding. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** One tiny request per model, bounded by `timeoutMs` in total; they run side by side. */
export async function probeModels(client: DecisionsApi, models: DecisionsConfig['models'], timeoutMs: number): Promise<DecisionsProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const [triage, text] = await Promise.all([
      client
        .decide({
          model: models.triage,
          state: imageState(TINY_PNG),
          questions: { frame: { type: 'choice', instructions: 'Is this image blank?', criteria: { yes: 'a blank image', no: 'not blank' } } },
          signal: controller.signal,
          timeoutMs,
        })
        .then((r) => toProbe(models.triage, r, choiceAnswer(r, 'frame') !== undefined)),
      client
        .decide({
          model: models.text,
          state: 'ping',
          questions: { ping: { type: 'noul', instructions: 'Is the state the word ping?' } },
          signal: controller.signal,
          timeoutMs,
        })
        .then((r) => toProbe(models.text, r, noulAnswer(r, 'ping') !== undefined)),
    ]);
    return { triage, text };
  } finally {
    clearTimeout(timer);
  }
}

function toProbe(model: string, r: Awaited<ReturnType<DecisionsApi['decide']>>, answered: boolean): ModelProbe {
  if (!r.ok) return { model, ok: false, ms: r.ms, error: r.error };
  if (!answered) return { model, ok: false, ms: r.ms, resolved: r.model, error: 'the model answered without the expected answer type' };
  return { model, ok: true, resolved: r.model, ms: r.ms };
}

/** The default doctor probe: a real client from the environment's key. Rejects when there is no key. */
export async function probeWithKey(env: NodeJS.ProcessEnv, configDir: string, models: DecisionsConfig['models'], timeoutMs: number): Promise<DecisionsProbe> {
  const key = loadApiKey(env, configDir);
  if (!key) throw new Error(`${API_KEY_ENV} is not set`);
  return probeModels(new DecisionsClient({ apiKey: key.key, timeoutMs }), models, timeoutMs);
}

export interface DecisionsCapability {
  tier: string;
  status: 'ok' | 'warn' | 'skipped';
  detail: string;
}

/** The doctor row, from the config, whether a key exists, and the probe (null when it was not run). */
export function describeDecisions(
  config: DecisionsConfig,
  key: { source: 'env' | '.env' } | null,
  probe: DecisionsProbe | null,
  why: string,
): DecisionsCapability {
  const mode = describeMode(config, key !== null);
  if (config.enabled === false) return { tier: 'off', status: 'ok', detail: mode };
  if (!key) {
    return { tier: 'heuristics-only', status: 'warn', detail: `${API_KEY_ENV} is not set (environment or .env next to the config); frame checks use the DOM heuristics only` };
  }
  const where = key.source === 'env' ? 'environment' : '.env next to the config';
  if (!probe) return { tier: 'key-present', status: 'ok', detail: `key from the ${where}; models not probed (${why}); ${mode}` };
  const line = (label: string, p: ModelProbe): string => {
    const id = p.resolved && p.resolved !== p.model ? `${p.model} -> ${p.resolved}` : p.model;
    return p.ok ? `${label} ${id} ok (${p.ms} ms)` : `${label} ${id} FAILED: ${p.error ?? 'no answer'}`;
  };
  const detail = `key from the ${where}; ${line('triage', probe.triage)}; ${line('text', probe.text)}; ${mode}`;
  if (probe.triage.ok && probe.text.ok) return { tier: 'openrouter', status: 'ok', detail };
  return { tier: 'degraded', status: 'warn', detail };
}
