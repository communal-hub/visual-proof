import path from 'node:path';
import { CONFIG_FILE_NAME, ConfigError, loadConfig, type Config } from './config.js';
import { EXIT } from './exit.js';
import { changeSet } from './git.js';
import { classifier } from './globs.js';
import { resolveDirs, statusFiles } from './paths.js';
import { buildImportGraph, type ImportGraph } from './resolve/import-graph.js';
import { loadSidecar } from './sidecar.js';
import { readStatusFile } from './status.js';
import { describeError } from './text.js';

/**
 * `visual-proof classify [paths...]` (v0.13): whether these files need visual proof, by the same rules the watcher and
 * `finish` use (`screenGlobs`, `ignoreScreenGlobs`, `backendGlobs`, `sidecars`), and which screens they reach. A PR gate
 * can call it instead of keeping its own copy of the rules.
 */

export type FileKind = 'screen' | 'backend' | 'sidecar';

export interface ClassifiedFile {
  /** Config-relative path, POSIX separators. */
  path: string;
  /** Empty when the file needs no proof. A file can be a screen and a backend file at once. */
  kinds: FileKind[];
  /** Screen files: route keys the import graph reaches from it (or `staticRoutes`). Sidecars: `sidecar <name> / <still>`. */
  screens?: string[];
  /** Screen files that no route renders; `finish` fails on these. */
  unmapped?: boolean;
}

export interface ClassifyResult {
  needsProof: boolean;
  files: ClassifiedFile[];
  /** Every screen the files reach, sorted (route keys, then sidecar stills). */
  screens: string[];
  /** Backend files: any page may show their data, so the routes captured in a session are the ones re-captured. */
  backend: string[];
  /** Set when no paths were given and the branch's changed files were classified. */
  range?: string | null;
  /** Why the screens could not be listed (the import graph failed). */
  error?: string;
}

export async function classifyFiles(
  config: Config,
  files: string[],
  opts: { buildGraph?: (config: Config) => Promise<ImportGraph> } = {},
): Promise<ClassifyResult> {
  const { isScreen, isBackend, isSidecar } = classifier(config);
  const classified: ClassifiedFile[] = [...new Set(files)].sort().map((file) => {
    const kinds: FileKind[] = [];
    if (isSidecar(file)) kinds.push('sidecar');
    if (isScreen(file)) kinds.push('screen');
    if (isBackend(file)) kinds.push('backend');
    return { path: file, kinds };
  });
  const result: ClassifyResult = { needsProof: classified.some((f) => f.kinds.length > 0), files: classified, screens: [], backend: [] };

  const screens = classified.filter((f) => f.kinds.includes('screen'));
  if (screens.length > 0) {
    try {
      const graph = await (opts.buildGraph ?? ((c: Config) => buildImportGraph(c)))(config);
      for (const file of screens) {
        const routes = graph.fileToRoutes.get(file.path) ?? config.staticRoutes[file.path] ?? [];
        file.screens = [...routes].sort();
        if (routes.length === 0) file.unmapped = true;
      }
    } catch (err) {
      result.error = `could not build the route graph: ${describeError(err)}`;
    }
  }
  for (const file of classified.filter((f) => f.kinds.includes('sidecar'))) {
    const sidecar = loadSidecar(config.repoDir, file.path);
    file.screens = sidecar.stills.map((still) => `sidecar ${sidecar.name} / ${still}`);
  }
  result.screens = [...new Set(classified.flatMap((f) => f.screens ?? []))].sort((a, b) => Number(a.startsWith('sidecar ')) - Number(b.startsWith('sidecar ')) || (a < b ? -1 : a > b ? 1 : 0));
  result.backend = classified.filter((f) => f.kinds.includes('backend')).map((f) => f.path);
  return result;
}

const SHOWN_SCREENS = 6;

export function renderClassify(result: ClassifyResult): string {
  const width = Math.min(60, Math.max(0, ...result.files.map((f) => f.path.length)));
  const lines = result.files.map((file) => {
    const kind = file.kinds.length > 0 ? file.kinds.join('+') : 'none';
    let reach = '';
    if (file.unmapped) reach = ' -> no route renders it (finish fails: add staticRoutes or ignoreScreenGlobs)';
    else if (file.screens && file.screens.length > 0) {
      const shown = file.screens.slice(0, SHOWN_SCREENS).join(', ');
      reach = ` -> ${shown}${file.screens.length > SHOWN_SCREENS ? ` (+${file.screens.length - SHOWN_SCREENS} more)` : ''}`;
    } else if (file.kinds.includes('backend')) reach = ' -> any page (the routes captured this session)';
    return `${file.path.padEnd(width)}  ${kind.padEnd(14)}${reach}`.trimEnd();
  });
  if (result.error) lines.push(`warning: ${result.error}`);
  const count = (kind: FileKind) => result.files.filter((f) => f.kinds.includes(kind)).length;
  lines.push(
    `needs proof: ${result.needsProof ? 'yes' : 'no'} (${count('screen')} screen, ${count('backend')} backend, ${count('sidecar')} sidecar file(s); ${result.screens.length} screen(s) reached)` +
      (result.range !== undefined ? `; diffed ${result.range ?? 'uncommitted changes only'}` : ''),
  );
  return `${lines.join('\n')}\n`;
}

export interface ClassifyCommandContext {
  configPath?: string;
  paths: string[];
  json?: boolean;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** `visual-proof classify [paths...] [--json]`: 0 whatever the answer (it is in the output), 3 setup error. */
export async function classifyCommand(ctx: ClassifyCommandContext): Promise<number> {
  const out = ctx.out ?? ((t) => process.stdout.write(t));
  const err = ctx.err ?? ((t) => process.stderr.write(t));
  const cwd = ctx.cwd ?? process.cwd();
  let config: Config;
  try {
    config = loadConfig({ configPath: path.resolve(cwd, ctx.configPath ?? CONFIG_FILE_NAME), cwd, env: ctx.env });
  } catch (e) {
    err(`visual-proof classify: ${describeError(e)}\n`);
    return e instanceof ConfigError ? EXIT.SETUP : EXIT.INTERNAL;
  }
  let files: string[];
  let range: string | null | undefined;
  if (ctx.paths.length > 0) {
    files = ctx.paths.map((p) => path.relative(config.repoDir, path.resolve(cwd, p)).split(path.sep).join('/'));
  } else {
    try {
      const anchor = readStatusFile(statusFiles(resolveDirs(ctx.env)).status)?.anchor;
      const changes = await changeSet(config.repoDir, config.baseRef, { anchor });
      files = changes.files;
      range = changes.range;
    } catch (e) {
      err(`visual-proof classify: cannot list the changed files: ${describeError(e)}\n`);
      return EXIT.SETUP;
    }
  }
  const result = await classifyFiles(config, files);
  if (range !== undefined) result.range = range;
  out(ctx.json ? `${JSON.stringify(result, null, 2)}\n` : renderClassify(result));
  return EXIT.OK;
}
