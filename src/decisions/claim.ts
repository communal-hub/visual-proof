import fs from 'node:fs';
import path from 'node:path';
import type { DecisionBudget } from './budget.js';
import { choiceAnswer, choiceConfidence, noulAnswer, type DecisionsApi } from './client.js';
import { truncateUtf8 } from '../text.js';
import { MAX_IMAGE_PARTS, MAX_STATE_IMAGE_BYTES, prepareImage } from './images.js';

export const SATISFIED_AT = 0.7;
export const NOT_VISIBLE_BELOW = 0.3;
const MAX_CRITERIA = 12;
const MAX_CRITERION_CHARS = 300;
/** UTF-8 bytes of page text all pages together may contribute. */
const TEXT_BUDGET_BYTES = 24_000;
const MAX_RENDERED_FILES = 40;

export type CriterionResult = 'satisfied' | 'partial' | 'not visible';
export type ClaimVerdict = 'satisfied' | 'partial' | 'not visible';

export interface ClaimPage {
  route: string;
  /** The clean headline still; images are required evidence, including icon-only UI. */
  png: string;
  /** Up to 8 KB of visible page text, including teleported overlays. */
  visibleText: string;
  renderedFiles: string[] | null;
}

export interface CriterionOutcome {
  text: string;
  /** Probability the criterion is satisfied by what the pages show; null when the model gave none. */
  probability: number | null;
  result: CriterionResult | 'unknown';
  reason?: string;
}

/** The advisory claim check as shown in the proof block. */
export interface ClaimReport {
  /** Where the claim came from (repo-relative when inside the repo, else as given). */
  source: string;
  criteria: CriterionOutcome[];
  /** Overall verdict derived in code from the criteria; `unknown` when no criterion got an answer. */
  verdict: ClaimVerdict | 'unknown';
  /** Routes whose pages were shown to the model. */
  routes: string[];
  /** Who the pages were captured as (the configured login email, else anonymous). */
  role: string;
  model?: string;
  note?: string;
}

/** Bullet (`-`, `*`, `+`) or numbered (`1.`, `1)`) lines are criteria; with none, the whole text is one criterion. */
export function splitCriteria(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const bullets: string[] = [];
  for (const line of lines) {
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line);
    if (m) bullets.push(m[1]!);
  }
  const criteria = bullets.length > 0 ? bullets : [text.replace(/\s+/g, ' ').trim()].filter((t) => t !== '');
  return criteria.slice(0, MAX_CRITERIA).map((c) => (c.length > MAX_CRITERION_CHARS ? `${c.slice(0, MAX_CRITERION_CHARS)}...` : c));
}

export function classify(probability: number): CriterionResult {
  if (probability >= SATISFIED_AT) return 'satisfied';
  if (probability < NOT_VISIBLE_BELOW) return 'not visible';
  return 'partial';
}

/** All satisfied: satisfied. None satisfied (all not visible): not visible. Anything else: partial. */
export function overallVerdict(results: CriterionResult[]): ClaimVerdict {
  if (results.length > 0 && results.every((r) => r === 'satisfied')) return 'satisfied';
  if (results.every((r) => r === 'not visible')) return 'not visible';
  return 'partial';
}

/** Where the claim lives: `claimFile` (relative to the config dir), else `<statusDir>/claim.md`. */
export function claimPath(claimFile: string | undefined, repoDir: string, statusDir: string): string {
  return claimFile ? path.resolve(repoDir, claimFile) : path.join(statusDir, 'claim.md');
}

export function readClaim(file: string): { text: string } | { missing: true } | { error: string } {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() === '' ? { error: 'the claim file is empty' } : { text };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    return { error: `cannot read the claim file (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
}

export interface ClaimInput {
  source: string;
  claim: string;
  pages: ClaimPage[];
  role: string;
}

/** One request, one `noul` per criterion, all against the same pages. Advisory: a failure is a report with a note. */
export async function checkClaim(
  input: ClaimInput,
  options: { client: DecisionsApi; model: string; budget: DecisionBudget; log?: (message: string) => void },
): Promise<ClaimReport> {
  const criteria = splitCriteria(input.claim);
  const base: ClaimReport = {
    source: input.source,
    criteria: criteria.map((text) => ({ text, probability: null, result: 'unknown' })),
    verdict: 'unknown',
    routes: input.pages.map((p) => p.route),
    role: input.role,
  };
  if (criteria.length === 0) return { ...base, note: 'the claim has no text' };
  if (input.pages.length === 0) return { ...base, note: 'no clean frames to check the claim against' };
  if (options.budget.expired()) return { ...base, note: 'skipped: decision budget exhausted' };

  const perPage = Math.min(8192, Math.floor(TEXT_BUDGET_BYTES / input.pages.length));
  const context = {
    claim: criteria,
    pages: input.pages.map((p) => ({
      route: p.route,
      visibleText: truncateUtf8(p.visibleText, perPage),
      renderedFiles: p.renderedFiles ? p.renderedFiles.slice(0, MAX_RENDERED_FILES) : null,
    })),
  };
  let state: unknown[];
  try {
    const prepared = await options.budget.race(Promise.all(input.pages.map((p) => prepareImage(p.png))));
    if (prepared === 'timeout') return { ...base, note: 'skipped: decision budget exhausted' };
    state = [JSON.stringify(context), ...prepared.flatMap((parts, i) => [`Screenshot of ${input.pages[i]!.route}:`, ...parts])];
    if (state.filter((p) => typeof p === 'object').length > MAX_IMAGE_PARTS || Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_IMAGE_BYTES) {
      return { ...base, note: 'claim check skipped: screenshot payload exceeds the image safety limit' };
    }
  } catch (err) {
    return { ...base, note: `claim check failed: cannot read screenshot (${(err as Error).message})` };
  }
  const questions = Object.fromEntries(
    criteria.flatMap((text, i) => [[
      `c${i}`,
      {
        type: 'noul' as const,
        instructions: `Do the screenshots and visible page text show that this claim criterion is satisfied: "${text}"? Judge visible evidence, including icons, colors, layout and dialogs. Component filenames are context only, never proof. An intentional empty state can be a clean page but does not satisfy a claim requiring absent data or controls. If an empty state contradicts the criterion, answer below 0.30.`,
        criteria: {
          true: 'the screenshots or visible text directly show the criterion is satisfied',
          false: 'the criterion is absent, contradicted by an empty state, or unsupported by visible evidence; rendered filenames alone are not evidence',
        },
      },
    ], [
      `reason${i}`,
      { type: 'choice' as const, instructions: `Why is this criterion satisfied or unsupported across the supplied pages: "${text}"? Choose empty_state only when it contradicts this specific criterion and no other page shows the required content.`, criteria: CLAIM_REASONS },
    ]]),
  );
  const call = options.client.decide({ model: options.model, state, questions, signal: options.budget.signal, timeoutMs: Math.min(15_000, options.budget.remainingMs()) });
  const result = await options.budget.race(call);
  if (result === 'timeout') return { ...base, note: 'skipped: decision budget exhausted' };
  if (!result.ok) return { ...base, note: result.kind === 'aborted' ? 'skipped: decision budget exhausted' : `claim check failed: ${result.error}` };

  const outcomes: CriterionOutcome[] = criteria.map((text, i) => {
    const answer = noulAnswer(result, `c${i}`);
    if (!answer) return { text, probability: null, result: 'unknown' };
    const reason = choiceAnswer(result, `reason${i}`);
    const contradiction = reason?.choice === 'empty_state' && (choiceConfidence(reason) ?? 0) >= SATISFIED_AT;
    const probability = Math.min(contradiction ? NOT_VISIBLE_BELOW - 0.01 : 1, Math.max(0, answer.noul));
    return { text, probability, result: classify(probability), ...(reason && Object.hasOwn(CLAIM_REASONS, reason.choice) ? { reason: CLAIM_REASONS[reason.choice as keyof typeof CLAIM_REASONS] } : {}) };
  });
  const answered = outcomes.filter((o) => o.result !== 'unknown');
  return {
    ...base,
    criteria: outcomes,
    // A criterion without an answer is not satisfied: it keeps the overall verdict from saying more than is known.
    verdict: answered.length === 0 ? 'unknown' : overallVerdict(outcomes.map((o) => (o.result === 'unknown' ? 'partial' : o.result))),
    model: result.model,
    ...(answered.length < outcomes.length ? { note: `${outcomes.length - answered.length} criterion(s) got no answer` } : {}),
  };
}

export const CLAIM_REASONS = {
  visible: 'The screenshots or visible text show the criterion.',
  partial: 'Only part of the criterion is visible; the rest is unsupported.',
  empty_state: 'A visible empty state contradicts the claim; the required content is absent.',
  absent: 'The required content or control is not visible in the supplied screenshots or text.',
  uncertain: 'The supplied evidence is insufficient to determine whether the criterion is satisfied.',
};
