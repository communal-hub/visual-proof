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
 * established (no import graph, a tree git cannot compare) means no carry.
 */

export interface CarryOptions {
  config: Pick<Config, 'repoDir' | 'screenGlobs' | 'ignoreScreenGlobs' | 'backendGlobs' | 'sidecars' | 'routeFiles' | 'staticRoutes'>;
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

export type CarryResult = { ok: true; fromTree: string } | { ok: false; reason: string };

export class Carrier {
  private readonly cls;
  private readonly isRouteFile;
  private readonly diffs = new Map<string, Promise<string[] | null>>();

  constructor(private readonly opts: CarryOptions) {
    this.cls = classifier(opts.config);
    this.isRouteFile = picomatch(opts.config.routeFiles, { dot: true });
  }

  /** Whether `frame` (older than HEAD, clean) still stands at HEAD's tree. */
  async check(frame: Frame, target: CarryTarget): Promise<CarryResult> {
    const { graph, headTree, config } = this.opts;
    const short = frame.treeHash.slice(0, 8);
    const stale = (why: string): CarryResult => ({ ok: false, reason: `the last clean frame, at tree ${short}, is stale: ${why}` });
    if (frame.status !== 'clean') return { ok: false, reason: '' };
    if (graph === null) return { ok: false, reason: `the last clean frame is at tree ${short}, but there is no import graph to tell what changed since` };
    if (frame.treeHash === headTree) return { ok: true, fromTree: frame.treeHash };

    let diff = this.diffs.get(frame.treeHash);
    if (!diff) this.diffs.set(frame.treeHash, (diff = treeDiff(config.repoDir, frame.treeHash, headTree)));
    const files = await diff;
    if (files === null) return { ok: false, reason: `the last clean frame is at tree ${short}, which git cannot compare with HEAD` };

    const rendered = new Set(frame.renderedFiles ?? []);
    const keys = new Set(target.keys);
    for (const file of files) {
      if (this.cls.isSidecar(file)) {
        if (file === target.sidecarFile) return stale(`${file} changed since`);
        continue;
      }
      if (rendered.has(file)) return stale(`${file} (rendered in it) changed since`);
      if (this.cls.isBackend(file)) return stale(`${file} (a backend file) changed since`);
      if (this.isRouteFile(file)) return stale(`${file} (a route file) changed since`);
      if (!this.cls.isScreen(file)) continue;
      const routes = graph.fileToRoutes.get(file) ?? config.staticRoutes[file] ?? [];
      if (routes.length === 0) return stale(`${file} (no route renders it) changed since`);
      if (routes.some((r) => keys.has(r))) return stale(`${file} changed since`);
    }
    return { ok: true, fromTree: frame.treeHash };
  }
}
