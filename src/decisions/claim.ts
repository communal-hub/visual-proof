import fs from 'node:fs';
import path from 'node:path';
import type { DecisionBudget } from './budget.js';
import { noulAnswer, type DecisionsApi } from './client.js';
import { trim } from './diff.js';

export const SATISFIED_AT = 0.7;
export const NOT_VISIBLE_BELOW = 0.3;
const MAX_CRITERIA = 12;
const MAX_CRITERION_CHARS = 300;
/** Characters of page text all pages together may contribute (the text model has a 32k-token window). */
const TEXT_BUDGET_CHARS = 24_000;
const MAX_RENDERED_FILES = 40;

export type CriterionResult = 'satisfied' | 'partial' | 'not visible';
export type ClaimVerdict = 'satisfied' | 'partial' | 'not visible';

export interface ClaimPage {
  route: string;
  /** Up to ~8 KB of the app root's visible text (from the frame's sidecar), or '' when there is none. */
  visibleText: string;
  renderedFiles: string[] | null;
}

export interface CriterionOutcome {
  text: string;
  /** Probability the criterion is satisfied by what the pages show; null when the model gave none. */
  probability: number | null;
  result: CriterionResult | 'unknown';
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

  const perPage = Math.max(500, Math.min(8192, Math.floor(TEXT_BUDGET_CHARS / input.pages.length)));
  const state = {
    claim: criteria,
    pages: input.pages.map((p) => ({
      route: p.route,
      visibleText: trim(p.visibleText, perPage),
      renderedFiles: p.renderedFiles ? p.renderedFiles.slice(0, MAX_RENDERED_FILES) : null,
    })),
  };
  const questions = Object.fromEntries(
    criteria.map((text, i) => [
      `c${i}`,
      {
        type: 'noul' as const,
        instructions: `Do the pages show that this claim criterion is satisfied: "${text}"`,
        criteria: {
          true: 'the visible text or the rendered component files show it is satisfied',
          false: 'nothing in the visible text or rendered files shows it (styling and layout are not visible in text)',
        },
      },
    ]),
  );
  const call = options.client.decide({ model: options.model, state, questions, signal: options.budget.signal });
  const result = await options.budget.race(call);
  if (result === 'timeout') return { ...base, note: 'skipped: decision budget exhausted' };
  if (!result.ok) return { ...base, note: result.kind === 'aborted' ? 'skipped: decision budget exhausted' : `claim check failed: ${result.error}` };

  const outcomes: CriterionOutcome[] = criteria.map((text, i) => {
    const answer = noulAnswer(result, `c${i}`);
    if (!answer) return { text, probability: null, result: 'unknown' };
    const probability = Math.min(1, Math.max(0, answer.noul));
    return { text, probability, result: classify(probability) };
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
