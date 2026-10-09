import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { ImportGraph } from '../resolve/import-graph.js';
import type { RouteResolution } from '../resolve/routes.js';
import type { DecisionBudget } from './budget.js';
import { classifyChange, pickCaptions, readRouteTitle, type CaptionSubject, type CaptionResult } from './captions.js';
import { checkClaim, claimPath, readClaim, type ClaimPage, type ClaimReport } from './claim.js';
import { fileDiff, trim } from './diff.js';
import { checkImages, describeImageCheck, imageCheckMessage, type ImageCheck } from './image-check.js';
import { pruneRoutes, type PruneOutcome } from './prune.js';
import type { DecisionRuntime } from './runtime.js';
import { readTextSidecar } from './sidecar.js';

/** One clean headline frame the decisions look at. */
export interface DecisionHeadline {
  /** Concrete route path. */
  route: string;
  routeKey: string;
  /** Changed files that led to the route. */
  sourceFiles: string[];
  via: 'screen' | 'backend' | 'sidecar';
  /** Absolute path of the frame's PNG. */
  png: string;
  renderedFiles: string[] | null;
}

/** What the decisions added to one route of the proof block. */
export interface RouteDecisions {
  imageCheck?: ImageCheck;
  caption?: string;
}

/** `decisions: N requests, M ms, $cost` and what was skipped. */
export interface DecisionsSummary {
  requests: number;
  ms: number;
  cost: number;
  inputTokens: number;
  failed: number;
}

export interface FinishDecisions {
  failures: string[];
  notes: string[];
  /** Keyed by the concrete route path of the headline. */
  routes: Map<string, RouteDecisions>;
  claim?: ClaimReport;
}

export interface FinishDecisionsInput {
  config: Config;
  runtime: DecisionRuntime;
  statusDir: string;
  /** The committed range finish diffed (`main...HEAD`), or null. */
  range: string | null;
  headlines: DecisionHeadline[];
  graph: ImportGraph;
}

const EXCERPT_CHARS = 300;

/** Prune before the daemon wait: which routes finish expects. Uses the cached decision when watch made one. */
export async function pruneForFinish(
  config: Config,
  runtime: DecisionRuntime,
  statusDir: string,
  files: string[],
  resolution: RouteResolution,
  graph: ImportGraph,
  range: string | null,
): Promise<PruneOutcome> {
  return runtime.phase((budget) =>
    pruneRoutes(files, resolution, {
      config: config.decisions,
      client: runtime.client,
      budget,
      statusDir,
      repoDir: config.repoDir,
      graph,
      diffFor: (file) => fileDiff(config.repoDir, range ?? 'HEAD', file),
      log: runtime.log,
    }),
  );
}

/**
 * Everything decided at finish from the headline frames, concurrently and inside one shared budget: the image
 * check (fails or notes), the claim verdict (advisory) and the captions. Whatever the deadline cuts off is
 * skipped with a note; nothing here throws.
 */
export async function runFinishDecisions(input: FinishDecisionsInput): Promise<FinishDecisions> {
  const { config, runtime, headlines } = input;
  const out: FinishDecisions = { failures: [], notes: [], routes: new Map() };
  const decisions = config.decisions;
  const client = runtime.client;
  if (!client || headlines.length === 0) return out;
  const forRoute = (route: string): RouteDecisions => {
    let entry = out.routes.get(route);
    if (!entry) out.routes.set(route, (entry = {}));
    return entry;
  };

  await runtime.phase(async (budget) => {
    const tasks: Array<Promise<void>> = [];
    if (decisions.triage !== 'off') tasks.push(imageTask(input, budget, out, forRoute));
    if (decisions.verdict) tasks.push(claimTask(input, budget, out));
    if (decisions.captions) tasks.push(captionTask(input, budget, out, forRoute));
    await Promise.all(tasks.map((t) => t.catch((err: Error) => out.notes.push(`decisions: ${err.message.split('\n')[0]}`))));
    if (budget.expired()) out.notes.push(`decisions: unfinished work was skipped at the ${decisions.budgetMs} ms budget`);
  });
  return out;
}

async function imageTask(
  input: FinishDecisionsInput,
  budget: DecisionBudget,
  out: FinishDecisions,
  forRoute: (route: string) => RouteDecisions,
): Promise<void> {
  const { config, runtime, headlines } = input;
  const mode = config.decisions.triage;
  if (mode === 'off') return;
  const checks = await checkImages(
    headlines.map((h) => ({ png: h.png, name: h.route })),
    { client: runtime.client!, model: config.decisions.models.triage, mode, budget, log: runtime.log },
  );
  const unknown = new Map<string, string[]>();
  headlines.forEach((h, i) => {
    const check = checks[i]!;
    forRoute(h.route).imageCheck = check;
    if (check.label === 'unknown') {
      const key = check.note ?? 'no answer';
      unknown.set(key, [...(unknown.get(key) ?? []), h.route]);
    } else if (check.action === 'fail') out.failures.push(imageCheckMessage(h.route, check));
    else if (check.action === 'warn') out.notes.push(imageCheckMessage(h.route, check));
  });
  for (const [why, routes] of unknown) out.notes.push(`image check unknown for ${routes.join(', ')}: ${why}`);
}

async function claimTask(input: FinishDecisionsInput, budget: DecisionBudget, out: FinishDecisions): Promise<void> {
  const { config, runtime, headlines } = input;
  const file = claimPath(config.claimFile, config.repoDir, input.statusDir);
  const shown = displayPath(config.repoDir, file);
  const claim = readClaim(file);
  if ('missing' in claim) {
    out.notes.push(`claim check skipped: no claim at ${shown} (write the claim there, or set claimFile)`);
    return;
  }
  if ('error' in claim) {
    out.notes.push(`claim check skipped: ${claim.error} (${shown})`);
    return;
  }
  const pages: ClaimPage[] = headlines.map((h) => ({
    route: h.route,
    png: h.png,
    visibleText: readTextSidecar(h.png) ?? '',
    renderedFiles: h.renderedFiles,
  }));
  const noText = pages.filter((p) => p.visibleText === '').map((p) => p.route);
  if (noText.length > 0) out.notes.push(`claim check: no page text was captured for ${noText.join(', ')} (frames from an older capture)`);
  out.claim = await checkClaim(
    { source: shown, claim: claim.text, pages, role: config.login.type === 'http-hook' && config.login.email ? config.login.email : 'anonymous' },
    { client: runtime.client!, model: config.decisions.models.triage, budget, log: runtime.log },
  );
  if (out.claim.note) out.notes.push(`claim check: ${out.claim.note}`);
}

async function captionTask(
  input: FinishDecisionsInput,
  budget: DecisionBudget,
  out: FinishDecisions,
  forRoute: (route: string) => RouteDecisions,
): Promise<void> {
  const { config, runtime, headlines, graph } = input;
  const changedFiles = [...new Set(headlines.flatMap((h) => h.sourceFiles))].sort();
  const base = input.range ?? 'HEAD';
  const diff = await fileDiff(config.repoDir, base, changedFiles, 200_000);
  const readFile = (file: string): string | null => {
    try {
      return fs.readFileSync(path.join(config.repoDir, file), 'utf8');
    } catch {
      return null;
    }
  };
  const subjects: CaptionSubject[] = headlines.map((h, i) => {
    const info = graph.routes.find((r) => r.path === h.routeKey);
    return {
      id: `c${i}`,
      route: h.route,
      title: readRouteTitle(config.repoDir, info?.routeFile, h.routeKey),
      files: h.sourceFiles,
      change: classifyChange(diff, readFile, h.sourceFiles),
      excerpt: (readTextSidecar(h.png) ?? '').slice(0, EXCERPT_CHARS),
    };
  });
  const { captions, note } = await pickCaptions(subjects, {
    client: runtime.client,
    model: config.decisions.models.text,
    budget,
    diff: trim(diff, 4000),
    log: runtime.log,
  });
  headlines.forEach((h, i) => {
    const result: CaptionResult | undefined = captions.get(`c${i}`);
    if (result) forRoute(h.route).caption = result.caption;
  });
  if (note) out.notes.push(note);
}

function displayPath(repoDir: string, file: string): string {
  const rel = path.relative(repoDir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file;
}

// ---- proof block -----------------------------------------------------------------

export function summarize(runtime: DecisionRuntime): DecisionsSummary {
  const { requests, cost, inputTokens, failed } = runtime.stats;
  return { requests, ms: Math.round(runtime.ms), cost, inputTokens, failed };
}

/** `decisions: 3 requests, 412 ms, $0.000412` */
export function renderFooter(summary: DecisionsSummary): string {
  return `decisions: ${summary.requests} request${summary.requests === 1 ? '' : 's'}, ${summary.ms} ms, $${summary.cost.toFixed(6)}`;
}

/** The status line of a still, extended with the image check when there was one. */
export function stillLine(base: string, decisions: RouteDecisions | undefined): string {
  return decisions?.imageCheck ? `${base} · ${describeImageCheck(decisions.imageCheck)}` : base;
}

/** The "Claim check (advisory)" section as markdown lines. */
export function renderClaimSection(claim: ClaimReport): string[] {
  const lines = ['**Claim check (advisory)**', ''];
  lines.push(`Claim: \`${claim.source}\` · routes: ${claim.routes.map((r) => `\`${r}\``).join(', ')} · role: ${claim.role}`);
  lines.push('', `Overall: ${claim.verdict}`, '');
  for (const c of claim.criteria) {
    const odds = c.probability === null ? 'no answer' : `${c.result}, ${c.probability.toFixed(2)}`;
    lines.push(`- ${escapeCaption(c.text)}: ${odds}${c.reason ? ` — ${escapeCaption(c.reason)}` : ''}`);
  }
  if (claim.note) lines.push('', `Note: ${escapeCaption(claim.note)}`);
  lines.push('', 'Advisory — reviewer decides.');
  return lines;
}

/** Markdown-safe caption text (it comes from file names and route titles). */
export function escapeCaption(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
}
