import { noulAnswer, type DecisionsApi } from './client.js';
import type { DecisionBudget } from './budget.js';
import { prepareImage } from './images.js';

/** At or above this the after shows the claimed change; below {@link UNCHANGED_BELOW} it does not. */
export const CHANGED_AT = 0.7;
export const UNCHANGED_BELOW = 0.3;

export type CompareResult = 'changed' | 'unclear' | 'unchanged' | 'unknown';

/** What the model made of one before/after pair against its claim line. */
export interface CompareCheck {
  result: CompareResult;
  /** Probability that the after shows the claimed change and the before does not; null without an answer. */
  probability: number | null;
  model?: string;
  note?: string;
}

export interface ComparePair {
  name: string;
  before: string;
  after: string;
  /** The claim line for the screen: what must be visible after the change. */
  expected: string;
}

export interface CompareOptions {
  client: DecisionsApi;
  model: string;
  budget: DecisionBudget;
}

const INSTRUCTIONS = (expected: string) =>
  `The first image is the page before the change, the second the same page after it. Does the after show this, where the before did not: "${expected}"?`;
const CRITERIA = {
  true: 'the after visibly shows what is described and the before does not: the change is on screen',
  false: 'the after does not show it, or the before already looked the same, or the difference is unrelated to the description',
};

/** One request per pair, side by side within the shared budget. Advisory: it never fails `finish`. */
export async function comparePairs(pairs: ComparePair[], options: CompareOptions): Promise<CompareCheck[]> {
  return Promise.all(pairs.map((pair) => compareOne(pair, options)));
}

async function compareOne(pair: ComparePair, options: CompareOptions): Promise<CompareCheck> {
  let state: unknown[];
  try {
    const [before, after] = await Promise.all([prepareImage(pair.before), prepareImage(pair.after)]);
    state = ['Before (without the change):', ...before, 'After (with the change):', ...after];
  } catch (err) {
    return { result: 'unknown', probability: null, note: `cannot read the pair for ${pair.name}: ${(err as Error).message}` };
  }
  const call = options.client.decide({
    model: options.model,
    state,
    questions: { change: { type: 'noul', instructions: INSTRUCTIONS(pair.expected), criteria: CRITERIA } },
    signal: options.budget.signal,
  });
  const answer = await options.budget.race(call);
  if (answer === 'timeout') return { result: 'unknown', probability: null, note: 'skipped: decision budget exhausted' };
  if (!answer.ok) return { result: 'unknown', probability: null, note: answer.error };
  const noul = noulAnswer(answer, 'change');
  if (!noul) return { result: 'unknown', probability: null, model: answer.model, note: 'the model answered without a probability' };
  const result: CompareResult = noul.noul >= CHANGED_AT ? 'changed' : noul.noul < UNCHANGED_BELOW ? 'unchanged' : 'unclear';
  return { result, probability: noul.noul, model: answer.model };
}

/** `before → after: changed as claimed (0.93)` */
export function describeCompare(check: CompareCheck): string {
  if (check.probability === null) return `before → after: no answer${check.note ? ` (${check.note})` : ''}`;
  const label = { changed: 'changed as claimed', unclear: 'unclear', unchanged: 'no change matching the claim', unknown: 'no answer' }[check.result];
  return `before → after: ${label} (${check.probability.toFixed(2)})`;
}
