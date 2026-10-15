import picomatch from 'picomatch';
import type { Config } from './config.js';
import { treeDiff } from './git.js';
import { classifier } from './globs.js';
import type { ImportGraph } from './resolve/import-graph.js';
import type { Frame } from './timeline.js';

/**
 * Carrying a frame forward. The watcher only re-captures the routes a save affects, so after two edits in a row
 * the first page's frame is at an earlier tree than HEAD even though nothing it shows has changed since. `finish`
 * accepts such a frame at HEAD when no file that differs between its tree and HEAD's can have changed it.
 *
 * A changed file makes a frame stale when it:
 *  - is a backend file (`backendGlobs`): any page may show its data;
 *  - is a route file (`routeFiles`): the import graph is not to be trusted for it;
 *  - is a screen file that no route renders (not in the graph or `staticRoutes`): it may feed anything;
 *  - is a screen file whose routes include one the frame depends on (a page route: its own key; a sidecar
 *    still: the routes its `goto` steps visit);
 *  - is in the component list the frame recorded as rendered (`renderedFiles`);
 *  - is the sidecar file a sidecar frame came from.
 * Files outside `screenGlobs`, `backendGlobs` and `sidecars` (docs, tests, config) never do. Anything that cannot be
 * established (no import graph, a tree git cannot compare) means no carry. The watcher applies the same rules to the
 * files that changed while it was capturing ({@link staleCheck}).
 */

export type CarryConfig = Pick<Config, 'repoDir' | 'screenGlobs' | 'ignoreScreenGlobs' | 'backendGlobs' | 'sidecars' | 'routeFiles' | 'staticRoutes'>;

export interface CarryOptions {
  config: CarryConfig;
  /** The import graph `finish` built, or null when it could not (then nothing is carried). */
  graph: ImportGraph | null;
  /** `HEAD^{tree}`. */
  headTree: string;
}

export interface CarryTarget {
  /** Route keys the frame depends on: a page's own key, or the routes a scenario visits. */
  keys: string[];
  /** Set for a sidecar still: the scenario file. */
  sidecarFile?: string;
}

/** What a frame depends on: its {@link CarryTarget} plus the components it rendered. */
export interface FrameDependencies extends CarryTarget {
  renderedFiles?: string[] | null;
}

/**
 * The file among `files` that can have changed what a frame with these dependencies shows, with why
 * (`src/S.vue (a backend file)`), or null when none can. The rules are listed at the top of this module; the watcher
 * uses the same check to keep frames through a change made while it was capturing.
 */
export type StaleCheck = (files: Iterable<string>, deps: FrameDependencies) => string | null;

export function staleCheck(config: CarryConfig, graph: ImportGraph): StaleCheck {
  const cls = classifier(config);
  const isRouteFile = picomatch(config.routeFiles, { dot: true });
  return (files, deps) => {
    const rendered = new Set(deps.renderedFiles ?? []);
    const keys = new Set(deps.keys);
    for (const file of files) {
      if (cls.isSidecar(file)) {
        if (file === deps.sidecarFile) return file;
        continue;
      }
      if (rendered.has(file)) return `${file} (rendered in it)`;
      if (cls.isBackend(file)) return `${file} (a backend file)`;
      if (isRouteFile(file)) return `${file} (a route file)`;
      if (!cls.isScreen(file)) continue;
      const routes = graph.fileToRoutes.get(file) ?? config.staticRoutes[file] ?? [];
      if (routes.length === 0) return `${file} (no route renders it)`;
      if (routes.some((r) => keys.has(r))) return file;
    }
    return null;
  };
}

export type CarryResult = { ok: true; fromTree: string } | { ok: false; reason: string };

export class Carrier {
  private readonly stale: StaleCheck | null;
  private readonly diffs = new Map<string, Promise<string[] | null>>();

  constructor(private readonly opts: CarryOptions) {
    this.stale = opts.graph ? staleCheck(opts.config, opts.graph) : null;
  }

  /** Whether `frame` (older than HEAD, clean) still stands at HEAD's tree. */
  async check(frame: Frame, target: CarryTarget): Promise<CarryResult> {
    const { headTree, config } = this.opts;
    const short = frame.treeHash.slice(0, 8);
    if (frame.status !== 'clean') return { ok: false, reason: '' };
    if (this.stale === null) return { ok: false, reason: `the last clean frame is at tree ${short}, but there is no import graph to tell what changed since` };
    if (frame.treeHash === headTree) return { ok: true, fromTree: frame.treeHash };

    let diff = this.diffs.get(frame.treeHash);
    if (!diff) this.diffs.set(frame.treeHash, (diff = treeDiff(config.repoDir, frame.treeHash, headTree)));
    const files = await diff;
    if (files === null) return { ok: false, reason: `the last clean frame is at tree ${short}, which git cannot compare with HEAD` };

    const why = this.stale(files, { ...target, renderedFiles: frame.renderedFiles });
    if (why !== null) return { ok: false, reason: `the last clean frame, at tree ${short}, is stale: ${why} changed since` };
    return { ok: true, fromTree: frame.treeHash };
  }
}
