import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { firstLine } from '../text.js';

export interface RouteParams {
  /** Config `routeParams` overlaid with the entries from `routeParamsFile`. Always usable. */
  params: Record<string, string>;
  /** Absolute path of `routeParamsFile`, when configured. */
  file?: string;
  /** The file was configured but does not exist (treated as empty). */
  missing: boolean;
  /** Valid entries read from the file. */
  fileEntries: number;
  /** The file exists but is unreadable, invalid JSON, or the wrong shape; config `routeParams` still apply. */
  error?: string;
  /** Entries ignored because the value is not a string starting with `/`. */
  warnings: string[];
}

type ParamConfig = Pick<Config, 'repoDir' | 'routeParams' | 'routeParamsFile'>;

/**
 * Config `routeParams` merged with the JSON file at `routeParamsFile`, which the app (e.g. a seeder)
 * may write at any time. The file is read on every call so a late write is picked up without a
 * restart; it is a few lines, so there is no cache to go stale. Never throws.
 *
 * File shape: `{ "routes": { "/invoices/:id": "/invoices/42" } }` or the flat `{ "/invoices/:id": "/invoices/42" }`.
 * Entries from the file win over config for the same key; other keys merge.
 */
export function loadRouteParams(config: ParamConfig): RouteParams {
  const result: RouteParams = { params: { ...config.routeParams }, missing: false, fileEntries: 0, warnings: [] };
  if (!config.routeParamsFile) return result;

  const file = path.resolve(config.repoDir, config.routeParamsFile);
  result.file = file;

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') result.missing = true;
    else result.error = `routeParamsFile ${config.routeParamsFile} cannot be read: ${firstLine(err)}`;
    return result;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    result.error = `routeParamsFile ${config.routeParamsFile} is not valid JSON: ${firstLine(err)}`;
    return result;
  }

  const entries = routeEntries(raw);
  if (typeof entries === 'string') {
    result.error = `routeParamsFile ${config.routeParamsFile} has the wrong shape: ${entries}`;
    return result;
  }
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string' || !value.startsWith('/')) {
      result.warnings.push(`routeParamsFile entry ${JSON.stringify(key)} ignored: value must be a string starting with "/", got ${JSON.stringify(value)}`);
      continue;
    }
    result.params[key] = value;
    result.fileEntries++;
  }
  return result;
}

/** The route-to-path object of either file shape, or a message saying why there is none. */
function routeEntries(raw: unknown): Record<string, unknown> | string {
  if (!isRecord(raw)) return 'expected a JSON object';
  if ('routes' in raw) {
    return isRecord(raw.routes) ? raw.routes : '"routes" must be an object of route to path';
  }
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
