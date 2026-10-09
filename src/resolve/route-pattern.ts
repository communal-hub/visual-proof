/**
 * Vue Router route patterns (`/invoices/:id`, `/users/:id(\d+)`, `/docs/:slug?`, `/files/:path+`, `/x/:rest*`) as
 * data: tokens, a matching regex, path building from param values, and the nearest known parent route.
 * Pure; used by link discovery (match an href against a route key) and by `params set` (validate values and
 * build the concrete path).
 */

export interface StaticToken {
  kind: 'static';
  text: string;
}

export interface ParamToken {
  kind: 'param';
  name: string;
  /** The custom regex between the parentheses, or null for the default (anything but `/`). */
  regex: string | null;
  /** `?` or `*`: the param may be absent. */
  optional: boolean;
  /** `+` or `*`: one or more segments. */
  repeat: boolean;
}

export type PatternToken = StaticToken | ParamToken;

export interface RoutePattern {
  raw: string;
  /** Tokens per segment (empty segments dropped); the root route has none. */
  segments: PatternToken[][];
  /** The raw text of each segment, to rebuild a parent pattern. */
  segmentTexts: string[];
  params: ParamToken[];
}

export type ParsedPattern = { ok: true; pattern: RoutePattern } | { ok: false; reason: string };

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /\w/;
const DEFAULT_PARAM = '[^/]+';

/** Parse a route key. A pattern the syntax does not cover (or an invalid custom regex) is an error with a reason. */
export function parseRoutePattern(raw: string): ParsedPattern {
  const segments: PatternToken[][] = [];
  const segmentTexts: string[] = [];
  const params: ParamToken[] = [];
  let tokens: PatternToken[] = [];
  let text = '';
  let staticText = '';

  const endStatic = (): void => {
    if (staticText !== '') tokens.push({ kind: 'static', text: staticText });
    staticText = '';
  };
  const endSegment = (): void => {
    endStatic();
    if (tokens.length > 0) {
      segments.push(tokens);
      segmentTexts.push(text);
    }
    tokens = [];
    text = '';
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '/') {
      endSegment();
      i++;
      continue;
    }
    if (ch === ':' && NAME_START.test(raw[i + 1] ?? '')) {
      endStatic();
      const start = i;
      i++;
      let name = '';
      while (i < raw.length && NAME_CHAR.test(raw[i]!)) name += raw[i++];
      let regex: string | null = null;
      if (raw[i] === '(') {
        const end = closingParen(raw, i);
        if (end === -1) return { ok: false, reason: `unbalanced "(" in ${raw}` };
        regex = raw.slice(i + 1, end);
        if (regex === '') return { ok: false, reason: `empty custom regex for :${name} in ${raw}` };
        try {
          new RegExp(`(?:${regex})`);
        } catch (err) {
          return { ok: false, reason: `invalid regex for :${name} in ${raw} (${(err as Error).message.split('\n')[0]})` };
        }
        i = end + 1;
      }
      let optional = false;
      let repeat = false;
      const modifier = raw[i];
      if (modifier === '?' || modifier === '+' || modifier === '*') {
        optional = modifier === '?' || modifier === '*';
        repeat = modifier === '+' || modifier === '*';
        i++;
      }
      const token: ParamToken = { kind: 'param', name, regex, optional, repeat };
      if (params.some((p) => p.name === name)) return { ok: false, reason: `param :${name} appears twice in ${raw}` };
      params.push(token);
      tokens.push(token);
      text += raw.slice(start, i);
      continue;
    }
    staticText += ch;
    text += ch;
    i++;
  }
  endSegment();

  for (const segment of segments) {
    const repeats = segment.some((t) => t.kind === 'param' && t.repeat);
    if (repeats && segment.length > 1) {
      return { ok: false, reason: `a repeatable param (+ or *) must be alone in its segment in ${raw}` };
    }
  }
  return { ok: true, pattern: { raw, segments, segmentTexts, params } };
}

/** Index of the `)` closing the `(` at `open`, skipping escapes, nested groups and character classes; -1 if none. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let inClass = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\') {
      i++;
    } else if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function paramSource(token: ParamToken): string {
  const body = `(?:${token.regex ?? DEFAULT_PARAM})`;
  return token.repeat ? `(?<${token.name}>${body}(?:/${body})*)` : `(?<${token.name}>${body})`;
}

/**
 * The regex a path of this route matches: case-insensitive, an optional trailing slash, an optional or `*` param
 * makes its whole segment optional. Null when the pattern cannot be parsed.
 */
export function routeRegex(pattern: string | RoutePattern): RegExp | null {
  const parsed = typeof pattern === 'string' ? parseRoutePattern(pattern) : { ok: true as const, pattern };
  if (!parsed.ok) return null;
  let body = '';
  for (const segment of parsed.pattern.segments) {
    const only = segment.length === 1 ? segment[0]! : null;
    if (only?.kind === 'param') {
      const inner = `/${paramSource(only)}`;
      body += only.optional ? `(?:${inner})?` : inner;
      continue;
    }
    body += '/';
    for (const token of segment) {
      if (token.kind === 'static') body += escapeRegex(token.text);
      else body += token.optional ? `${paramSource(token)}?` : paramSource(token);
    }
  }
  try {
    return new RegExp(`^${body}/?$`, 'i');
  } catch {
    return null;
  }
}

/** The pathname without query, hash or a trailing slash (the root stays `/`). */
export function normalizePathname(pathname: string): string {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
}

/** The param values of `pathname` when it matches the pattern, else null. */
export function matchRoute(pattern: string | RoutePattern, pathname: string): Record<string, string> | null {
  const regex = routeRegex(pattern);
  if (!regex) return null;
  const match = regex.exec(normalizePathname(pathname));
  if (!match) return null;
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(match.groups ?? {})) if (value !== undefined) values[name] = value;
  return values;
}

export type BuiltPath = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The concrete path for a pattern and param values. Required params must be given, every given value must fit
 * its param (the custom regex, or no `/` in a single-segment param) and nothing else may be given. Values are
 * URL-encoded; a repeatable param takes `a/b/c`.
 */
export function buildPath(pattern: string | RoutePattern, values: Record<string, string>): BuiltPath {
  const parsed = typeof pattern === 'string' ? parseRoutePattern(pattern) : { ok: true as const, pattern };
  if (!parsed.ok) return parsed;
  const { segments, params, raw } = parsed.pattern;

  const extra = Object.keys(values).filter((name) => !params.some((p) => p.name === name));
  if (extra.length > 0) {
    return { ok: false, reason: `${raw} has no param ${extra.join(', ')}${params.length > 0 ? ` (params: ${params.map((p) => p.name).join(', ')})` : ' (it has no params)'}` };
  }
  const missing = params.filter((p) => !p.optional && values[p.name] === undefined).map((p) => p.name);
  if (missing.length > 0) {
    return { ok: false, reason: `${raw} needs ${missing.join(', ')}` };
  }
  for (const token of params) {
    const value = values[token.name];
    if (value === undefined) continue;
    const bad = checkValue(token, value);
    if (bad) return { ok: false, reason: bad };
  }

  let path = '';
  for (const segment of segments) {
    let built = '';
    let skip = false;
    for (const token of segment) {
      if (token.kind === 'static') {
        built += token.text;
        continue;
      }
      const value = values[token.name];
      if (value === undefined) {
        if (segment.length === 1) skip = true;
        continue;
      }
      built += token.repeat ? value.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(value);
    }
    if (!skip) path += `/${built}`;
  }
  return { ok: true, path: path === '' ? '/' : path };
}

function checkValue(token: ParamToken, value: string): string | null {
  if (value === '') return `${token.name} must not be empty`;
  const parts = token.repeat ? value.split('/') : [value];
  if (!token.repeat && value.includes('/') && token.regex === null) return `${token.name}=${JSON.stringify(value)} must not contain "/"`;
  const fit = new RegExp(`^(?:${token.regex ?? DEFAULT_PARAM})$`);
  for (const part of parts) {
    if (part === '' || !fit.test(part)) {
      return `${token.name}=${JSON.stringify(value)} does not fit ${token.regex !== null ? `(${token.regex})` : 'a path segment'}`;
    }
  }
  return null;
}

/** Names of the params a caller must give for the pattern (optional ones may be left out). */
export function requiredParams(pattern: string | RoutePattern): string[] {
  const parsed = typeof pattern === 'string' ? parseRoutePattern(pattern) : { ok: true as const, pattern };
  return parsed.ok ? parsed.pattern.params.filter((p) => !p.optional).map((p) => p.name) : [];
}

/** True when the route key has any param (even an optional one). */
export function hasParams(routeKey: string): boolean {
  const parsed = parseRoutePattern(routeKey);
  return parsed.ok ? parsed.pattern.params.length > 0 : /:[A-Za-z_]/.test(routeKey);
}

/** True when the route key has a param that has to be filled before it can be loaded. */
export function needsParams(routeKey: string): boolean {
  return requiredParams(routeKey).length > 0;
}

/**
 * The nearest ancestor of `routeKey` that is a known route: drop trailing segments one at a time until what is
 * left is in `known` (`/clubs/:clubId/teams/:teamId` -> `/clubs/:clubId/teams`). Null when no ancestor is a route.
 */
export function nearestParent(routeKey: string, known: Iterable<string>): string | null {
  const parsed = parseRoutePattern(routeKey);
  if (!parsed.ok) return null;
  const set = new Set(known);
  const texts = parsed.pattern.segmentTexts;
  for (let keep = texts.length - 1; keep >= 0; keep--) {
    const candidate = `/${texts.slice(0, keep).join('/')}`;
    if (set.has(candidate)) return candidate;
  }
  return null;
}

/** How specific a pattern is: its fully static segments. `/invoices/create` (2) beats `/invoices/:id` (1). */
export function specificity(pattern: string | RoutePattern): number {
  const parsed = typeof pattern === 'string' ? parseRoutePattern(pattern) : { ok: true as const, pattern };
  if (!parsed.ok) return 0;
  return parsed.pattern.segments.filter((segment) => segment.every((t) => t.kind === 'static')).length;
}

/** The known route that matches `pathname` and is more specific than `routeKey` (so the path is not really `routeKey`'s), if any. */
export function moreSpecificRoute(routeKey: string, pathname: string, known: Iterable<string>): string | null {
  const own = specificity(routeKey);
  for (const other of known) {
    if (other === routeKey) continue;
    if (specificity(other) > own && matchRoute(other, pathname) !== null) return other;
  }
  return null;
}
