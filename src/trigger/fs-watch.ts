import path from 'node:path';
import chokidar from 'chokidar';
import picomatch from 'picomatch';

/** Repo-relative POSIX paths that changed in one debounce window, split by glob set. */
export interface WatchBatch {
  screen: string[];
  backend: string[];
  /** Epoch ms of the first event in this window; lets the HMR barrier credit a message that beat the debounce. */
  startedAt: number;
}

export interface FsWatchOptions {
  repoDir: string;
  screenGlobs: string[];
  backendGlobs: string[];
  /** Absolute directories never reported (status and scratch dirs). `node_modules` and `.git` are always ignored. */
  ignorePaths?: string[];
  /** Quiet period after the last event before a batch is emitted. Default 150 ms. */
  debounceMs?: number;
  /**
   * Wait for file sizes to settle before reporting. Off by default: only paths are reported (not
   * contents) and the capture that follows is already delayed by the debounce plus the HMR barrier,
   * so partial writes are not a problem. Turning it on costs at least `pollInterval` (50 ms here)
   * plus `stabilityThreshold` (100 ms) of extra latency per save.
   */
  awaitWriteFinish?: boolean;
  /**
   * Pause after chokidar reports `ready` before resolving. On macOS the OS-level watch is armed
   * slightly after `ready` (observed: ~1 in 20 saves made in the first few ms were silently
   * missed, more under CPU load; 25 ms was enough in 120 trials). Default 100 ms.
   */
  settleMs?: number;
  onBatch: (batch: WatchBatch) => void;
  onError?: (error: Error) => void;
}

export interface FsWatchHandle {
  /** Stops watching and cancels any pending (unemitted) batch. Safe to call twice. */
  stop(): Promise<void>;
}

const ALWAYS_IGNORED = new Set(['node_modules', '.git']);

/**
 * Chokidar watcher over `screenGlobs` and `backendGlobs`. Resolves once the initial scan is done
 * and the OS watches have had a moment to arm, so edits made after the promise resolves are seen.
 *
 * Chokidar 4+ has no glob support, so this watches the literal directory prefix of each glob and
 * filters events with picomatch.
 */
export async function startFsWatch(options: FsWatchOptions): Promise<FsWatchHandle> {
  const repoDir = path.resolve(options.repoDir);
  const debounceMs = options.debounceMs ?? 150;
  const isScreen = picomatch(options.screenGlobs, { dot: true });
  const isBackend = picomatch(options.backendGlobs, { dot: true });
  const ignoredRoots = (options.ignorePaths ?? []).map((p) => path.resolve(p));

  const toRel = (abs: string): string => path.relative(repoDir, abs).split(path.sep).join('/');

  const roots = [...new Set([...options.screenGlobs, ...options.backendGlobs].map(globBase))].map((base) =>
    path.join(repoDir, base),
  );

  const watcher = chokidar.watch(roots, {
    ignoreInitial: true,
    atomic: false,
    awaitWriteFinish: options.awaitWriteFinish ? { stabilityThreshold: 100, pollInterval: 50 } : false,
    ignored: (candidate, stats) => {
      const abs = path.resolve(candidate);
      if (ALWAYS_IGNORED.has(path.basename(abs))) return true;
      if (ignoredRoots.some((root) => abs === root || abs.startsWith(root + path.sep))) return true;
      // Directories are never filtered by glob (a directory can match no pattern yet contain matches).
      if (stats?.isFile()) {
        const rel = toRel(abs);
        return !isScreen(rel) && !isBackend(rel);
      }
      return false;
    },
  });

  const screen = new Set<string>();
  const backend = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let startedAt = 0;

  const flush = (): void => {
    timer = null;
    if (stopped || (screen.size === 0 && backend.size === 0)) return;
    const batch: WatchBatch = { screen: [...screen].sort(), backend: [...backend].sort(), startedAt };
    screen.clear();
    backend.clear();
    try {
      options.onBatch(batch);
    } catch (err) {
      options.onError?.(err as Error);
    }
  };

  const onFile = (abs: string): void => {
    if (stopped) return;
    const rel = toRel(abs);
    if (rel === '' || rel.startsWith('../')) return;
    const s = isScreen(rel);
    const b = isBackend(rel);
    if (!s && !b) return;
    if (screen.size === 0 && backend.size === 0) startedAt = Date.now();
    if (s) screen.add(rel);
    if (b) backend.add(rel);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  watcher.on('add', onFile).on('change', onFile).on('unlink', onFile);
  watcher.on('error', (err) => options.onError?.(err instanceof Error ? err : new Error(String(err))));

  await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, options.settleMs ?? 100));

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      screen.clear();
      backend.clear();
      await watcher.close();
    },
  };
}

/** Leading non-glob directory of a glob (`src/**` -> `src`, `**\/*.vue` -> ``). */
export function globBase(glob: string): string {
  const base: string[] = [];
  for (const segment of glob.replace(/^\.\//, '').split('/')) {
    if (/[*?{}[\]()!]/.test(segment)) break;
    base.push(segment);
  }
  // A glob with no wildcard names a file; watch its directory so create-after-start is seen.
  if (base.length === glob.replace(/^\.\//, '').split('/').length) base.pop();
  return base.join('/');
}
