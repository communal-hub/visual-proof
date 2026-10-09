import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../status.js';
import { firstLine } from '../text.js';

/** One route's params as the agent set them with `visual-proof params set`. */
export interface SessionEntry {
  /** Concrete path built from the params, e.g. `/invoices/5`. */
  path: string;
  params: Record<string, string>;
  /** ISO time of the `set`. */
  at: string;
}

/** What the session file holds (`<statusDir>/session-params.json`); never committed, it lives in the status dir. */
export interface SessionParams {
  /** Bumped on every write; the watcher acknowledges the highest revision it has handled in `status.json`. */
  rev: number;
  routes: Record<string, SessionEntry>;
  /** The file exists but is unreadable or the wrong shape; the entries are then empty. */
  error?: string;
  /** Entries ignored because they are malformed. */
  warnings: string[];
}

const EMPTY: SessionParams = { rev: 0, routes: {}, warnings: [] };

/** The session file, never throwing: a missing file is empty, a broken one is empty with an `error`. */
export function readSessionParams(file: string): SessionParams {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, routes: {}, warnings: [] };
    return { ...EMPTY, routes: {}, warnings: [], error: `session params file cannot be read: ${firstLine(err)}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ...EMPTY, routes: {}, warnings: [], error: `session params file is not valid JSON: ${firstLine(err)}` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...EMPTY, routes: {}, warnings: [], error: 'session params file has the wrong shape: expected a JSON object' };
  }
  const object = raw as Record<string, unknown>;
  const routesRaw = object.routes;
  if (typeof routesRaw !== 'object' || routesRaw === null || Array.isArray(routesRaw)) {
    return { ...EMPTY, routes: {}, warnings: [], error: 'session params file has the wrong shape: "routes" must be an object' };
  }
  const routes: Record<string, SessionEntry> = {};
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(routesRaw as Record<string, unknown>)) {
    const entry = value as Partial<SessionEntry> | null;
    if (typeof entry !== 'object' || entry === null || typeof entry.path !== 'string' || !entry.path.startsWith('/')) {
      warnings.push(`session params entry ${JSON.stringify(key)} ignored: it has no path starting with "/"`);
      continue;
    }
    const params = isStringRecord(entry.params) ? entry.params : {};
    routes[key] = { path: entry.path, params, at: typeof entry.at === 'string' ? entry.at : '' };
  }
  const rev = typeof object.rev === 'number' && Number.isInteger(object.rev) && object.rev >= 0 ? object.rev : 0;
  return { rev, routes, warnings };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string');
}

function write(file: string, routes: Record<string, SessionEntry>, rev: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify({ version: 1, rev, routes }, null, 2)}\n`);
}

/** Set (or replace) one route's params. Returns the new revision. A broken existing file is replaced. */
export function setSessionParams(file: string, routeKey: string, entry: SessionEntry): number {
  const current = readSessionParams(file);
  const rev = current.rev + 1;
  write(file, { ...current.routes, [routeKey]: entry }, rev);
  return rev;
}

/** Remove one route's params, or all of them with no key. Returns the keys removed and the new revision. */
export function clearSessionParams(file: string, routeKey?: string): { cleared: string[]; rev: number } {
  const current = readSessionParams(file);
  const keys = Object.keys(current.routes);
  const cleared = routeKey === undefined ? keys : keys.filter((k) => k === routeKey);
  if (cleared.length === 0 && current.error === undefined) return { cleared, rev: current.rev };
  const rest = Object.fromEntries(Object.entries(current.routes).filter(([k]) => !cleared.includes(k)));
  const rev = current.rev + 1;
  write(file, rest, rev);
  return { cleared, rev };
}

/** Routes whose entry is new or different between two reads (what the watcher should capture). */
export function changedSessionRoutes(before: Record<string, SessionEntry>, after: Record<string, SessionEntry>): string[] {
  return Object.keys(after)
    .filter((key) => before[key]?.path !== after[key]!.path || before[key]?.at !== after[key]!.at)
    .sort();
}
