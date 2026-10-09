import fs from 'node:fs';
import path from 'node:path';

/**
 * OpenRouter Decisions API client (A4): fast typed answers (`choice`, `noul`, `score`) at bounded decision
 * points. Never free text, never navigation. One request carries one state and any number of questions, which
 * the provider evaluates in parallel against that state.
 *
 * Spike findings (v0.6, live) this client is built around:
 *  - `criteria` is validated per question type before the model is looked up: `choice` takes a record of
 *    choice -> description, `score` an array of anchors, `noul` an optional `{ true, false }` record.
 *  - A `noul` answer is the probability of "yes"; a `choice` answer carries `probabilities` and `confidence`.
 *  - Images go in `state` as `[{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }]`
 *    (about 1.2k input tokens for a 1280x800 still). Any other encoding is silently read as text.
 *  - An unknown model is a 400 `Model <id> does not exist`.
 */

export const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_TIMEOUT_MS = 8000;
export const API_KEY_ENV = 'OPENROUTER_API_KEY';

/** `choice`: record of choice -> description. `noul`: optional `{ true, false }` descriptions. `score`: array of anchors. */
export type Criteria = Record<string, string> | string[];

export interface Question {
  type: 'choice' | 'noul' | 'score';
  instructions: string;
  criteria?: Criteria;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface NoulAnswer {
  type: 'noul';
  /** Probability (0..1) that the answer to the question is "yes". */
  noul: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
  /** Dollars, as reported by OpenRouter. */
  cost: number;
}

export interface DecisionRequest {
  /** Model id as configured; the answer reports the id it resolved to. */
  model: string;
  /** Text/JSON for a text model, or an array of plain text strings and `image_url` parts for a vision model. */
  state: unknown;
  questions: Record<string, Question>;
  /** Aborts the request (and any retry back-off), e.g. when a decision budget runs out. */
  signal?: AbortSignal;
  /** Overrides the client's per-request timeout. */
  timeoutMs?: number;
}

export type DecisionErrorKind = 'no-key' | 'timeout' | 'aborted' | 'http' | 'network' | 'invalid';

export type DecisionResult =
  | { ok: true; answers: Record<string, Answer>; model: string; requestedModel: string; usage: DecisionUsage; ms: number }
  | { ok: false; kind: DecisionErrorKind; error: string; status?: number; ms: number };

export interface DecisionStats {
  /** Requests that reached the network (a retry is not a new request). */
  requests: number;
  failed: number;
  retries: number;
  /** Sum of the wall time of each request, retries and back-off included. */
  ms: number;
  cost: number;
  inputTokens: number;
}

/** What the decision modules need from a client; tests substitute fakes. */
export interface DecisionsApi {
  decide(request: DecisionRequest): Promise<DecisionResult>;
  readonly stats: DecisionStats;
}

export interface DecisionsClientOptions {
  apiKey: string;
  endpoint?: string;
  /** Per-request timeout (each attempt). Default 8 s. */
  timeoutMs?: number;
  /** Upper bound for honoring `retry-after` and for the default back-off. Default 3 s. */
  maxBackoffMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export class DecisionsClient implements DecisionsApi {
  readonly stats: DecisionStats = { requests: 0, failed: 0, retries: 0, ms: 0, cost: 0, inputTokens: 0 };
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: DecisionsClientOptions) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? 3000;
    this.fetchFn = options.fetch ?? fetch;
    this.sleepFn = options.sleep ?? sleep;
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    const started = Date.now();
    const finish = (result: DecisionResult): DecisionResult => {
      const ms = Date.now() - started;
      this.stats.ms += ms;
      if (result.ok) {
        this.stats.cost += result.usage.cost;
        this.stats.inputTokens += result.usage.inputTokens;
        return { ...result, ms };
      }
      this.stats.failed++;
      return { ...result, ms };
    };

    if (request.signal?.aborted) return { ok: false, kind: 'aborted', error: 'decision budget exhausted', ms: 0 };
    this.stats.requests++;

    let attempt = await this.attempt(request);
    if (!attempt.ok && attempt.retryable && !request.signal?.aborted) {
      const wait = Math.min(attempt.retryAfterMs ?? 400 + Math.floor(Math.random() * 300), this.maxBackoffMs);
      this.stats.retries++;
      this.options.log?.(`decisions: ${attempt.error}; retrying once in ${wait} ms`);
      try {
        await this.sleepFn(wait, request.signal);
      } catch {
        return finish({ ok: false, kind: 'aborted', error: 'decision budget exhausted', ms: 0 });
      }
      attempt = await this.attempt(request);
    }
    if (attempt.ok) return finish(attempt.result);
    return finish({ ok: false, kind: attempt.kind, error: attempt.error, ...(attempt.status !== undefined ? { status: attempt.status } : {}), ms: 0 });
  }

  private async attempt(
    request: DecisionRequest,
  ): Promise<
    | { ok: true; result: Extract<DecisionResult, { ok: true }> }
    | { ok: false; kind: DecisionErrorKind; error: string; status?: number; retryable: boolean; retryAfterMs?: number }
  > {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs ?? this.timeoutMs);
    const onAbort = (): void => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'x-title': 'visual-proof',
        },
        body: JSON.stringify({ model: request.model, state: request.state, questions: request.questions }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        return {
          ok: false,
          kind: 'http',
          status: response.status,
          error: `HTTP ${response.status}: ${this.clean(apiMessage(text))}`,
          retryable: RETRY_STATUSES.has(response.status),
          ...(retryAfterMs(response.headers.get('retry-after')) !== undefined ? { retryAfterMs: retryAfterMs(response.headers.get('retry-after'))! } : {}),
        };
      }
      return this.parse(request, text);
    } catch (err) {
      if (request.signal?.aborted) return { ok: false, kind: 'aborted', error: 'decision budget exhausted', retryable: false };
      if (timedOut) return { ok: false, kind: 'timeout', error: `no answer within ${request.timeoutMs ?? this.timeoutMs} ms`, retryable: false };
      return { ok: false, kind: 'network', error: this.clean(describe(err)), retryable: false };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  private parse(
    request: DecisionRequest,
    text: string,
  ): { ok: true; result: Extract<DecisionResult, { ok: true }> } | { ok: false; kind: 'invalid'; error: string; retryable: false } {
    const invalid = (error: string) => ({ ok: false as const, kind: 'invalid' as const, error, retryable: false as const });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return invalid('response is not JSON');
    }
    if (!isRecord(body) || !isRecord(body.answers)) return invalid('response has no answers');
    const answers: Record<string, Answer> = {};
    for (const [id, raw] of Object.entries(body.answers)) {
      const answer = toAnswer(raw);
      if (answer) answers[id] = answer;
    }
    const usage = isRecord(body.usage) ? body.usage : {};
    return {
      ok: true,
      result: {
        ok: true,
        answers,
        model: typeof body.model === 'string' ? body.model : request.model,
        requestedModel: request.model,
        usage: { inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens), cost: num(usage.cost) },
        ms: 0,
      },
    };
  }

  /** Error text goes to logs, proof blocks and notes: never let the key travel with it. */
  private clean(message: string): string {
    const oneLine = message.replace(/\s+/g, ' ').trim().slice(0, 240);
    return oneLine.split(this.options.apiKey).join('<key>');
  }
}

/** A client that answers every request with the same failure; used when no key is available. */
export class UnavailableClient implements DecisionsApi {
  readonly stats: DecisionStats = { requests: 0, failed: 0, retries: 0, ms: 0, cost: 0, inputTokens: 0 };
  constructor(private readonly reason = `${API_KEY_ENV} is not set`) {}
  async decide(): Promise<DecisionResult> {
    return { ok: false, kind: 'no-key', error: this.reason, ms: 0 };
  }
}

// ---- typed access -----------------------------------------------------------

export function choiceAnswer(result: DecisionResult, id: string): ChoiceAnswer | undefined {
  if (!result.ok) return undefined;
  const answer = result.answers[id];
  return answer?.type === 'choice' ? answer : undefined;
}

export function noulAnswer(result: DecisionResult, id: string): NoulAnswer | undefined {
  if (!result.ok) return undefined;
  const answer = result.answers[id];
  return answer?.type === 'noul' ? answer : undefined;
}

/** The confidence the provider reported, else the probability of the chosen option, else null. */
export function choiceConfidence(answer: ChoiceAnswer): number | null {
  if (typeof answer.confidence === 'number') return answer.confidence;
  const p = answer.probabilities?.[answer.choice];
  return typeof p === 'number' ? p : null;
}

/** A `state` holding one PNG as an `image_url` part, the only encoding the image model reads as an image. */
export function imageState(png: Buffer): unknown[] {
  return [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }];
}

// ---- key --------------------------------------------------------------------

export interface ApiKey {
  key: string;
  source: 'env' | '.env';
}

/** `OPENROUTER_API_KEY` from the environment, else from a `.env` file in `configDir`; null when neither has one. */
export function loadApiKey(env: NodeJS.ProcessEnv, configDir?: string): ApiKey | null {
  const fromEnv = env[API_KEY_ENV]?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  if (!configDir) return null;
  let text: string;
  try {
    text = fs.readFileSync(path.join(configDir, '.env'), 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[1]!;
    const quoted = /^(["'])(.*)\1/.exec(value);
    value = quoted ? quoted[2]! : value.replace(/\s+#.*$/, '');
    if (value) return { key: value, source: '.env' };
  }
  return null;
}

// ---- helpers ----------------------------------------------------------------

function toAnswer(raw: unknown): Answer | null {
  if (!isRecord(raw)) return null;
  if (raw.type === 'noul' && typeof raw.noul === 'number') return { type: 'noul', noul: raw.noul };
  if (raw.type === 'choice' && typeof raw.choice === 'string') {
    return {
      type: 'choice',
      choice: raw.choice,
      ...(isRecord(raw.probabilities) ? { probabilities: numbers(raw.probabilities) } : {}),
      ...(typeof raw.confidence === 'number' ? { confidence: raw.confidence } : {}),
    };
  }
  if (raw.type === 'score' && typeof raw.score === 'number') {
    return {
      type: 'score',
      score: raw.score,
      ...(isRecord(raw.probabilities) ? { probabilities: numbers(raw.probabilities) } : {}),
      ...(typeof raw.confidence === 'number' ? { confidence: raw.confidence } : {}),
    };
  }
  return null;
}

function numbers(record: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(record)) if (typeof v === 'number') out[k] = v;
  return out;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function apiMessage(text: string): string {
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') return body.error.message;
  } catch {
    // not JSON: fall through to the raw text
  }
  return text;
}

function describe(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  return e.cause?.code ?? e.cause?.message ?? e.message ?? String(err);
}

/** `retry-after` as delay seconds or an HTTP date, in ms; undefined when absent or unusable. */
function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
