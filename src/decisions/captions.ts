import fs from 'node:fs';
import path from 'node:path';
import type { DecisionBudget } from './budget.js';
import { choiceAnswer, type DecisionsApi } from './client.js';
import { trim } from './diff.js';

export type ChangeKind = 'style' | 'template' | 'script' | 'data' | 'content';

/** What kind of change a diff makes: which sections of a .vue file, or what a plain file is. */
export function classifyChange(diff: string, readFile: (file: string) => string | null, only?: readonly string[]): ChangeKind[] {
  const kinds = new Set<ChangeKind>();
  for (const part of splitDiff(diff)) {
    if (only && !only.includes(part.file)) continue;
    const ext = path.posix.extname(part.file).toLowerCase();
    if (ext === '.vue') {
      const ranges = vueSections(readFile(part.file) ?? '');
      for (const line of part.lines) kinds.add(sectionAt(ranges, line) ?? 'content');
    } else if (['.css', '.scss', '.sass', '.less', '.styl'].includes(ext)) kinds.add('style');
    else if (['.html', '.htm', '.pug', '.hbs'].includes(ext)) kinds.add('template');
    else if (['.js', '.mjs', '.cjs', '.ts', '.mts', '.tsx', '.jsx'].includes(ext)) kinds.add('script');
    else if (['.json', '.yml', '.yaml', '.csv'].includes(ext)) kinds.add('data');
    else kinds.add('content');
  }
  return [...kinds].sort();
}

interface DiffPart {
  file: string;
  /** New-side line numbers of every added line and of the spot where lines were removed. */
  lines: number[];
}

function splitDiff(diff: string): DiffPart[] {
  const parts: DiffPart[] = [];
  let current: DiffPart | null = null;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { file: header[2]!, lines: [] };
      parts.push(current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!current || newLine === 0) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) current.lines.push(newLine++);
    else if (line.startsWith('-') && !line.startsWith('---')) current.lines.push(newLine);
    else if (line.startsWith(' ')) newLine++;
  }
  return parts;
}

interface Section {
  kind: ChangeKind;
  from: number;
  to: number;
}

/** Line ranges (1-based, inclusive) of the top-level `<template>`, `<script>` and `<style>` blocks. */
function vueSections(source: string): Section[] {
  const out: Section[] = [];
  const lines = source.split('\n');
  let open: { kind: ChangeKind; from: number; tag: string } | null = null;
  lines.forEach((text, i) => {
    const n = i + 1;
    if (!open) {
      const m = /^<(template|script|style)\b/.exec(text);
      if (m) {
        open = { kind: m[1] === 'template' ? 'template' : m[1] === 'script' ? 'script' : 'style', from: n, tag: m[1]! };
        if (new RegExp(`</${m[1]}>\\s*$`).test(text)) {
          out.push({ kind: open.kind, from: n, to: n });
          open = null;
        }
      }
    } else if (new RegExp(`^</${open.tag}>`).test(text)) {
      out.push({ kind: open.kind, from: open.from, to: n });
      open = null;
    }
  });
  return out;
}

function sectionAt(ranges: Section[], line: number): ChangeKind | null {
  return ranges.find((r) => line >= r.from && line <= r.to)?.kind ?? null;
}

// ---- route titles -------------------------------------------------------------

/**
 * The `title` of a route as its route file declares it (`meta: { title: 'Reports' }` or `title: 'Reports'` after
 * the route's `path:`), or null. Not a JS parser: the text between this route's `path:` literal and the next one.
 */
export function routeTitle(routeFileSource: string, routeKey: string): string | null {
  const segments = [routeKey, routeKey.split('/').filter(Boolean).pop() ?? ''].filter((s) => s !== '');
  for (const segment of segments) {
    const re = new RegExp(`path\\s*:\\s*(['"\`])${escapeRegExp(segment)}\\1`);
    const m = re.exec(routeFileSource);
    if (!m) continue;
    const rest = routeFileSource.slice(m.index + m[0].length);
    const next = /path\s*:\s*['"`]/.exec(rest);
    const window = rest.slice(0, next ? next.index : 400).slice(0, 400);
    const title = /\btitle\s*:\s*(['"`])((?:(?!\1).){1,80})\1/.exec(window);
    if (title) return title[2]!;
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function readRouteTitle(repoDir: string, routeFile: string | undefined, routeKey: string): string | null {
  if (!routeFile) return null;
  try {
    return routeTitle(fs.readFileSync(path.join(repoDir, routeFile), 'utf8'), routeKey);
  } catch {
    return null;
  }
}

// ---- candidates ---------------------------------------------------------------

export interface CaptionSubject {
  /** Stable id for the batch (`c0`...). */
  id: string;
  route: string;
  /** The route title from the route file, or null (the path is used). */
  title: string | null;
  /** Changed files that led to the route (repo-relative). */
  files: string[];
  change: ChangeKind[];
  /** A little of the visible text, for the model. */
  excerpt?: string;
}

/** 3 to 5 distinct captions built in code; the first is the default when the model cannot pick. */
export function captionCandidates(subject: CaptionSubject): string[] {
  const name = subject.title ?? subject.route;
  const files = subject.files.map((f) => path.posix.basename(f));
  const shown = files.length > 3 ? `${files.slice(0, 3).join(', ')} and ${files.length - 3} more` : files.join(', ');
  const change = subject.change.length > 0 ? subject.change.join(' and ') : 'content';
  const where = subject.title ? `${subject.title} (${subject.route})` : subject.route;
  const list = [
    shown ? `${name} after the ${change} change to ${shown}` : `${name} after the ${change} change`,
    shown ? `${where}: ${shown} changed` : `${where} after the change`,
    `${name}: ${change} change`,
    shown ? `${name} with updated ${shown}` : `${name}, updated`,
    `${where} at the committed state`,
  ];
  return [...new Set(list)].slice(0, 5);
}

export interface CaptionResult {
  /** The chosen caption (the first candidate when the model did not pick). */
  caption: string;
  source: 'model' | 'template';
}

const KEYS = ['a', 'b', 'c', 'd', 'e'];

/**
 * One request for all headline stills: a `choice` per still between its candidates. Anything that fails or
 * is unfinished at the deadline falls back to the first candidate (a template), never to an error.
 */
export async function pickCaptions(
  subjects: CaptionSubject[],
  options: { client: DecisionsApi | null; model: string; budget: DecisionBudget; diff: string; log?: (message: string) => void },
): Promise<{ captions: Map<string, CaptionResult>; note?: string }> {
  const candidates = new Map(subjects.map((s) => [s.id, captionCandidates(s)]));
  const results = new Map<string, CaptionResult>();
  for (const s of subjects) results.set(s.id, { caption: candidates.get(s.id)![0]!, source: 'template' });
  if (!options.client || subjects.length === 0) return { captions: results };
  if (options.budget.expired()) return { captions: results, note: 'captions use templates: decision budget exhausted' };

  const state = {
    change: trim(options.diff, 4000),
    frames: subjects.map((s) => ({ id: s.id, route: s.route, title: s.title, files: s.files, change: s.change, visibleText: s.excerpt ?? '' })),
  };
  const questions = Object.fromEntries(
    subjects.map((s) => [
      s.id,
      {
        type: 'choice' as const,
        instructions: `Pick the caption that best describes frame ${s.id} (route ${s.route}) for a reviewer reading the proof.`,
        criteria: Object.fromEntries(candidates.get(s.id)!.map((text, i) => [KEYS[i]!, text])),
      },
    ]),
  );
  const call = options.client.decide({ model: options.model, state, questions, signal: options.budget.signal });
  const result = await options.budget.race(call);
  if (result === 'timeout' || !result.ok) {
    const why = result === 'timeout' || result.kind === 'aborted' ? 'decision budget exhausted' : result.error;
    options.log?.(`decisions: captions fell back to templates (${why})`);
    return { captions: results, note: `captions use templates: ${why}` };
  }
  for (const s of subjects) {
    const answer = choiceAnswer(result, s.id);
    const index = answer ? KEYS.indexOf(answer.choice) : -1;
    const text = index >= 0 ? candidates.get(s.id)![index] : undefined;
    if (text) results.set(s.id, { caption: text, source: 'model' });
  }
  return { captions: results };
}
