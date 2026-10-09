import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Answer,
  ChoiceAnswer,
  DecisionRequest,
  DecisionResult,
  DecisionStats,
  DecisionsApi,
  NoulAnswer,
} from '../../src/decisions/client.js';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/decisions');

/** A recorded Decisions API response body (the real shape, captured live). */
export function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

export const choice = (label: string, confidence = 1, others: Record<string, number> = {}): ChoiceAnswer => ({
  type: 'choice',
  choice: label,
  probabilities: { [label]: confidence, ...others },
  confidence,
});
export const noul = (n: number): NoulAnswer => ({ type: 'noul', noul: n });

export const okResult = (answers: Record<string, Answer>, extra: { model?: string; inputTokens?: number; cost?: number } = {}): DecisionResult => ({
  ok: true,
  answers,
  model: extra.model ?? 'fake/model-1',
  requestedModel: 'fake/model',
  usage: { inputTokens: extra.inputTokens ?? 100, outputTokens: 0, cost: extra.cost ?? 0.0001 },
  ms: 5,
});

/** A scripted client: `handler` decides every answer; calls and stats are recorded like the real client's. */
export class FakeClient implements DecisionsApi {
  readonly calls: DecisionRequest[] = [];
  readonly stats: DecisionStats = { requests: 0, failed: 0, retries: 0, ms: 0, cost: 0, inputTokens: 0 };
  inFlight = 0;
  maxInFlight = 0;

  constructor(private readonly handler: (request: DecisionRequest, n: number) => DecisionResult | Promise<DecisionResult>) {}

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    this.calls.push(request);
    this.stats.requests++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const result = await this.handler(request, this.calls.length);
      if (result.ok) {
        this.stats.cost += result.usage.cost;
        this.stats.inputTokens += result.usage.inputTokens;
      } else this.stats.failed++;
      this.stats.ms += result.ms;
      return result;
    } finally {
      this.inFlight--;
    }
  }

  /** Requests that went to the text model vs the image model, by the shape of `state`. */
  get imageCalls(): DecisionRequest[] {
    return this.calls.filter((c) => Array.isArray(c.state));
  }
  get textCalls(): DecisionRequest[] {
    return this.calls.filter((c) => !Array.isArray(c.state));
  }
}

/** A promise that never settles on its own but gives up when the request is aborted: a stuck provider. */
export function hang(request: DecisionRequest): Promise<DecisionResult> {
  return new Promise((resolve) => {
    request.signal?.addEventListener('abort', () => resolve({ ok: false, kind: 'aborted', error: 'decision budget exhausted', ms: 0 }), { once: true });
  });
}
