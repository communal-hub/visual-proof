import fs from 'node:fs';
import { choiceAnswer, choiceConfidence, imageState, type DecisionsApi } from './client.js';
import type { DecisionBudget } from './budget.js';

export type ImageLabel = 'clean' | 'loading' | 'error' | 'blank';

/** A non-clean answer at or above this confidence is acted on (fail or note). */
export const IMAGE_CONFIDENCE_THRESHOLD = 0.7;
/** A 1280x800 still costs about 1.2k input tokens. Far more means the image was read as text (wrong encoding). */
export const IMAGE_TOKEN_GUARD = 2000;
/** Concurrent image requests. */
export const IMAGE_CONCURRENCY = 6;

const LABELS: readonly ImageLabel[] = ['clean', 'loading', 'error', 'blank'];

export const IMAGE_INSTRUCTIONS =
  'Classify what this screenshot of a web application page shows. The page was just loaded in a headless browser; judge only what is visible in the pixels.';

export const IMAGE_CRITERIA: Record<ImageLabel, string> = {
  clean: 'a normally rendered page with real content (text, tables, forms, charts) in the main area; an intentional empty-state message such as "No invoices yet" counts as clean',
  loading: 'a loading state: a spinner, skeleton placeholders or "Loading..." text where the content should be',
  error: 'an error state: an error message or banner, a crash or stack trace, "something went wrong", a 404 or 500 page',
  blank: 'an empty page: nothing but navigation or header chrome, or a plain white page, with no content in the main area',
};

/** What the image check concluded about one frame; recorded on the route in the proof block. */
export interface ImageCheck {
  /** The model's choice, or `unknown` when it gave no usable answer. */
  label: ImageLabel | 'unknown';
  confidence: number | null;
  /** `none`: clean (or too unsure to act on); `fail` / `warn`: a non-clean answer at or above the threshold, per `triage`. */
  action: 'none' | 'fail' | 'warn';
  model?: string;
  ms: number;
  /** Why the answer is `unknown` (error, budget, token guard), or a remark. */
  note?: string;
}

export interface ImageCheckInput {
  /** Path of the PNG to look at. */
  png: string;
  /** Free-form label for logs. */
  name: string;
}

export interface ImageCheckOptions {
  client: DecisionsApi;
  model: string;
  mode: 'fail' | 'warn';
  budget: DecisionBudget;
  log?: (message: string) => void;
  concurrency?: number;
}

/**
 * One request per image (not several images per request): in the spike the model read a single image with
 * confidence 1.0, while four images in one request drifted to 0.5 to 0.9 and could land under the threshold.
 * Requests run concurrently (at most `concurrency`) and share the budget; whatever is unfinished at the deadline is
 * `unknown` with a note.
 */
export async function checkImages(inputs: ImageCheckInput[], options: ImageCheckOptions): Promise<ImageCheck[]> {
  const results: ImageCheck[] = new Array(inputs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= inputs.length) return;
      results[i] = await checkOne(inputs[i]!, options);
    }
  };
  const workers = Array.from({ length: Math.min(options.concurrency ?? IMAGE_CONCURRENCY, inputs.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function checkOne(input: ImageCheckInput, options: ImageCheckOptions): Promise<ImageCheck> {
  const started = Date.now();
  const unknown = (note: string): ImageCheck => ({ label: 'unknown', confidence: null, action: 'none', ms: Date.now() - started, note });
  if (options.budget.expired()) return unknown('skipped: decision budget exhausted');

  let png: Buffer;
  try {
    png = fs.readFileSync(input.png);
  } catch (err) {
    return unknown(`cannot read ${input.png}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  const call = options.client.decide({
    model: options.model,
    state: imageState(png),
    questions: { frame: { type: 'choice', instructions: IMAGE_INSTRUCTIONS, criteria: IMAGE_CRITERIA } },
    signal: options.budget.signal,
  });
  const result = await options.budget.race(call);
  if (result === 'timeout') return unknown('skipped: decision budget exhausted');
  if (!result.ok) return unknown(result.kind === 'aborted' ? 'skipped: decision budget exhausted' : result.error);

  if (result.usage.inputTokens > IMAGE_TOKEN_GUARD) {
    const message = `image check for ${input.name} used ${result.usage.inputTokens} input tokens (limit ${IMAGE_TOKEN_GUARD}): the image was probably read as text, so the answer is ignored`;
    options.log?.(`decisions: ERROR ${message}`);
    return { ...unknown(message), model: result.model };
  }
  const answer = choiceAnswer(result, 'frame');
  if (!answer || !LABELS.includes(answer.choice as ImageLabel)) {
    return { ...unknown(`no usable answer (${answer ? JSON.stringify(answer.choice) : 'missing'})`), model: result.model };
  }
  const label = answer.choice as ImageLabel;
  const confidence = choiceConfidence(answer);
  const flagged = label !== 'clean' && confidence !== null && confidence >= IMAGE_CONFIDENCE_THRESHOLD;
  return { label, confidence, action: flagged ? options.mode : 'none', model: result.model, ms: result.ms };
}

export function describeImageCheck(check: ImageCheck): string {
  if (check.label === 'unknown') return 'image check: unknown';
  return `image check: ${check.label}${check.confidence === null ? '' : ` (${check.confidence.toFixed(2)})`}`;
}

/** `<route> looks <label> to the image check (<confidence>)`: the failure / note text. */
export function imageCheckMessage(route: string, check: ImageCheck): string {
  return `${route} looks ${check.label} to the image check (${check.confidence === null ? 'n/a' : check.confidence.toFixed(2)})`;
}
