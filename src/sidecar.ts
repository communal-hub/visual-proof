import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { DEFAULT_ROLE, ROLE_NAME, type Config } from './config.js';
import { globBase } from './trigger/fs-watch.js';

/**
 * Sidecar scenarios: a `.vp` file is a short script of interaction steps that ends in one or more stills, for
 * states a page does not show on load (an open modal, step 2 of a form, another role's view).
 *
 * ```
 * # comment
 * goto /manage/invoices/:id
 * click [data-test=invoice-refund]
 * fill [data-test=amount] "12.50"
 * press Enter
 * wait [data-test=refund-modal]
 * still refund-modal
 * login finance
 * ```
 *
 * One line per step; blank lines and lines starting with `#` are skipped (a `#` later in a line is part of the
 * line: `click #submit` is a selector). One file is one scenario, named by its filename.
 */

export const SIDECAR_VERBS = ['goto', 'click', 'fill', 'press', 'wait', 'still', 'login'] as const;
export type SidecarVerb = (typeof SIDECAR_VERBS)[number];

interface StepBase {
  /** 1-based line in the file. */
  line: number;
  /** The line as written, trimmed. */
  text: string;
}

export type SidecarStep =
  | (StepBase & { verb: 'goto'; target: string })
  | (StepBase & { verb: 'click'; selector: string })
  | (StepBase & { verb: 'fill'; selector: string; value: string })
  | (StepBase & { verb: 'press'; key: string })
  | (StepBase & { verb: 'wait'; selector?: string; ms?: number })
  | (StepBase & { verb: 'still'; name: string })
  | (StepBase & { verb: 'login'; role: string });

export interface SidecarError {
  /** 1-based line, or 0 for a problem with the file as a whole. */
  line: number;
  message: string;
}

export interface Sidecar {
  /** Path relative to the config directory, POSIX separators. */
  file: string;
  /** The filename without its extension. */
  name: string;
  steps: SidecarStep[];
  /** Names of the `still` steps, in order. */
  stills: string[];
  errors: SidecarError[];
}

/** Longest single `wait <ms>`. */
export const MAX_WAIT_MS = 30_000;

const STILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function sidecarName(file: string): string {
  return path.posix.basename(file).replace(/\.[^./]*$/, '');
}

/** The route (and route key) of a frame taken by `still <name>` in `file`. */
export function sidecarRoute(file: string, still: string): string {
  return `sidecar:${file}#${still}`;
}

/** Route of the synthetic frame recorded when a step fails after the last pending `still`. Cannot collide with a still name. */
export const FAILED_STILL = '!failed';

export function isSidecarRoute(route: string): boolean {
  return route.startsWith('sidecar:');
}

/** `sidecar:<file>#<still>` back into its parts, or null. */
export function parseSidecarRoute(route: string): { file: string; still: string } | null {
  if (!isSidecarRoute(route)) return null;
  const hash = route.lastIndexOf('#');
  if (hash < 0) return null;
  return { file: route.slice('sidecar:'.length, hash), still: route.slice(hash + 1) };
}

export function formatSidecarError(file: string, error: SidecarError): string {
  return error.line > 0 ? `${file}:${error.line}: ${error.message}` : `${file}: ${error.message}`;
}

/** Parse the text of a sidecar file. Never throws: problems are collected, with their line numbers, in `errors`. */
export function parseSidecar(text: string, file: string): Sidecar {
  const steps: SidecarStep[] = [];
  const errors: SidecarError[] = [];
  const seenStills = new Map<string, number>();

  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  lines.forEach((raw, index) => {
    const line = index + 1;
    const body = raw.trim();
    if (body === '' || body.startsWith('#')) return;

    const space = body.search(/\s/);
    const verb = space < 0 ? body : body.slice(0, space);
    const rest = space < 0 ? '' : body.slice(space).trim();
    const fail = (message: string): void => {
      errors.push({ line, message });
    };
    const base = { line, text: body };

    switch (verb) {
      case 'goto': {
        if (rest === '') return fail('goto needs a route key or path, e.g. goto /manage/invoices/:id');
        if (/\s/.test(rest)) return fail(`goto takes one route key or path, got ${JSON.stringify(rest)}`);
        if (!rest.startsWith('/') || rest.startsWith('//')) return fail(`goto target must be a route key or path starting with "/", got ${JSON.stringify(rest)}`);
        steps.push({ ...base, verb, target: rest });
        return;
      }
      case 'click': {
        if (rest === '') return fail('click needs a selector, e.g. click [data-test=save]');
        steps.push({ ...base, verb, selector: rest });
        return;
      }
      case 'fill': {
        const parsed = parseFill(rest);
        if ('error' in parsed) return fail(parsed.error);
        steps.push({ ...base, verb, selector: parsed.selector, value: parsed.value });
        return;
      }
      case 'press': {
        if (rest === '') return fail('press needs a key, e.g. press Enter');
        if (/\s/.test(rest)) return fail(`press takes one key such as Enter or Control+A, got ${JSON.stringify(rest)}`);
        steps.push({ ...base, verb, key: rest });
        return;
      }
      case 'wait': {
        if (rest === '') return fail('wait needs a selector or a number of milliseconds, e.g. wait 500');
        const ms = /^(\d+)(?:ms)?$/.exec(rest);
        if (ms) {
          const value = Number(ms[1]);
          if (value < 1 || value > MAX_WAIT_MS) return fail(`wait <ms> must be between 1 and ${MAX_WAIT_MS}, got ${value}`);
          steps.push({ ...base, verb, ms: value });
        } else {
          steps.push({ ...base, verb, selector: rest });
        }
        return;
      }
      case 'still': {
        if (rest === '') return fail('still needs a name, e.g. still refund-modal');
        if (!STILL_NAME.test(rest)) return fail(`still name must be letters, digits, ".", "_" or "-" (no spaces), got ${JSON.stringify(rest)}`);
        const first = seenStills.get(rest);
        if (first !== undefined) return fail(`duplicate still name "${rest}" (first used on line ${first})`);
        seenStills.set(rest, line);
        steps.push({ ...base, verb, name: rest });
        return;
      }
      case 'login': {
        if (rest === '') return fail('login needs a role, e.g. login finance');
        if (!ROLE_NAME.test(rest)) return fail(`login takes one role name, got ${JSON.stringify(rest)}`);
        steps.push({ ...base, verb, role: rest });
        return;
      }
      default:
        return fail(`unknown verb ${JSON.stringify(verb)} (the verbs are ${SIDECAR_VERBS.join(', ')})`);
    }
  });

  if (steps.length > 0 && seenStills.size === 0 && errors.length === 0) {
    errors.push({ line: 0, message: 'no still step: a scenario that never takes a still proves nothing' });
  }
  if (steps.length === 0 && errors.length === 0) {
    errors.push({ line: 0, message: 'no steps (the file is empty or only comments)' });
  }
  return { file, name: sidecarName(file), steps, stills: steps.filter((s) => s.verb === 'still').map((s) => (s as { name: string }).name), errors };
}

/**
 * `<selector> <text...>`: the selector is the first whitespace-delimited word, or a quoted string when it
 * contains spaces; the text is the rest of the line, raw, or one quoted string (use `""` for empty text).
 */
function parseFill(rest: string): { selector: string; value: string } | { error: string } {
  const usage = 'fill needs a selector and text, e.g. fill [data-test=name] "Ada Lovelace" (use "" for empty text)';
  if (rest === '') return { error: usage };
  const first = readWord(rest);
  if ('error' in first) return first;
  const tail = first.rest.trim();
  if (first.selector === '') return { error: 'fill selector must not be empty' };
  if (tail === '') return { error: usage };
  if (tail.startsWith('"') || tail.startsWith("'")) {
    const quoted = readQuoted(tail);
    if ('error' in quoted) return quoted;
    if (quoted.rest.trim() !== '') return { error: `unexpected text after the closing quote: ${JSON.stringify(quoted.rest.trim())}` };
    return { selector: first.selector, value: quoted.value };
  }
  return { selector: first.selector, value: tail };
}

function readWord(rest: string): { selector: string; rest: string } | { error: string } {
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const quoted = readQuoted(rest);
    if ('error' in quoted) return quoted;
    return { selector: quoted.value, rest: quoted.rest };
  }
  const space = rest.search(/\s/);
  return space < 0 ? { selector: rest, rest: '' } : { selector: rest.slice(0, space), rest: rest.slice(space) };
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', '\\': '\\', '"': '"', "'": "'" };

/** A quoted string at the start of `text`; backslash escapes `\\ \" \' \n \t` (any other `\x` is kept as written). */
function readQuoted(text: string): { value: string; rest: string } | { error: string } {
  const quote = text[0]!;
  let value = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]!;
      value += ESCAPES[next] ?? `\\${next}`;
      i++;
    } else if (ch === quote) {
      return { value, rest: text.slice(i + 1) };
    } else {
      value += ch;
    }
  }
  return { error: `missing closing ${quote} quote` };
}

// ---- finding and loading ---------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Config-relative POSIX paths of the files matching the `sidecars` globs, sorted. */
export function findSidecarFiles(repoDir: string, globs: string[]): string[] {
  if (globs.length === 0) return [];
  const match = picomatch(globs, { dot: true });
  const bases = [...new Set(globs.map(globBase))];
  const roots = bases.filter((b) => !bases.some((o) => o !== b && (o === '' || b.startsWith(`${o}/`))));
  const found = new Set<string>();
  const walk = (dirRel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(repoDir, dirRel), { withFileTypes: true });
    } catch {
      return; // a glob base that does not exist matches nothing
    }
    for (const entry of entries) {
      const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(rel);
      } else if (entry.isFile() && match(rel)) {
        found.add(rel);
      }
    }
  };
  for (const root of roots) walk(root);
  return [...found].sort();
}

/** Read and parse one sidecar file; an unreadable file is a parse error rather than a throw. */
export function loadSidecar(repoDir: string, file: string): Sidecar {
  try {
    return parseSidecar(fs.readFileSync(path.join(repoDir, file), 'utf8'), file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unreadable';
    return { file, name: sidecarName(file), steps: [], stills: [], errors: [{ line: 0, message: `cannot read the file (${code})` }] };
  }
}

/** Problems that need the config to see: roles that are not configured, `login` with no login hook. */
export function validateSidecar(sidecar: Sidecar, config: Pick<Config, 'roles' | 'login'>): SidecarError[] {
  const errors: SidecarError[] = [...sidecar.errors];
  for (const step of sidecar.steps) {
    if (step.verb !== 'login') continue;
    if (config.login.type !== 'http-hook') {
      errors.push({ line: step.line, message: 'login needs a login hook: set login.type to "http-hook"' });
    } else if (step.role !== DEFAULT_ROLE && config.roles[step.role] === undefined) {
      const known = [DEFAULT_ROLE, ...Object.keys(config.roles)].join(', ');
      errors.push({ line: step.line, message: `unknown role ${JSON.stringify(step.role)} (known: ${known}; add it to "roles")` });
    }
  }
  return errors.sort((a, b) => a.line - b.line);
}

/** Login email for `login <role>`, or null for a role nobody configured. */
export function roleEmail(role: string, config: Pick<Config, 'roles' | 'login'>): string | null {
  if (role === DEFAULT_ROLE) return config.login.email ?? null;
  return config.roles[role] ?? null;
}

// ---- which routes a scenario touches ---------------------------------------------

const PARAM = /:[A-Za-z_]\w*(?:\([^)]*\))?[?*+]?/g;
const HAS_PARAM = /:[A-Za-z_]\w*/;

/** A route pattern (`/invoices/:id`) as an anchored regexp over concrete paths. */
function routeMatcher(routeKey: string): RegExp {
  const parts = routeKey.split(PARAM).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('[^/]+')}/?$`);
}

/**
 * The route keys a `goto` target stands for: itself when it is one (`/invoices/:id`), else the known routes
 * whose pattern matches the concrete path (query and hash ignored). A route with no params wins over
 * parametrised ones that also match. A target that matches nothing known still stands for itself.
 */
export function gotoRouteKeys(target: string, knownKeys: Iterable<string>): string[] {
  const known = [...knownKeys];
  if (known.includes(target)) return [target];
  const pathname = target.split(/[?#]/)[0]!;
  const matches = known.filter((key) => routeMatcher(key).test(pathname));
  const exact = matches.filter((key) => !HAS_PARAM.test(key));
  if (exact.length > 0) return exact;
  return matches.length > 0 ? matches : [pathname];
}

/** Every route key the scenario's `goto` steps stand for. */
export function scenarioRouteKeys(sidecar: Pick<Sidecar, 'steps'>, knownKeys: Iterable<string>): string[] {
  const known = [...knownKeys];
  const keys = new Set<string>();
  for (const step of sidecar.steps) {
    if (step.verb === 'goto') for (const key of gotoRouteKeys(step.target, known)) keys.add(key);
  }
  return [...keys];
}
