import path from 'node:path';
import chokidar from 'chokidar';

export interface SessionWatchHandle {
  stop(): Promise<void>;
}

/**
 * Calls `onChange` whenever `session-params.json` is created, rewritten (the CLI replaces it atomically) or removed.
 * This is how a running watcher learns of `visual-proof params set`: it needs no socket or signal, only the status
 * dir both processes already share. Resolves once the OS watch is armed, so a `set` made after it is seen.
 */
export async function watchSessionParams(
  file: string,
  onChange: () => void,
  onError?: (error: Error) => void,
): Promise<SessionWatchHandle> {
  const target = path.resolve(file);
  // Watch the directory, not the file: the file may not exist yet, and a rename-over replaces its inode.
  const watcher = chokidar.watch(path.dirname(target), {
    ignoreInitial: true,
    depth: 0,
    atomic: false,
    ignored: (candidate, stats) => stats?.isFile() === true && path.resolve(candidate) !== target,
  });
  let stopped = false;
  const handle = (changed: string): void => {
    if (!stopped && path.resolve(changed) === target) onChange();
  };
  watcher.on('add', handle).on('change', handle).on('unlink', handle);
  watcher.on('error', (err) => onError?.(err instanceof Error ? err : new Error(String(err))));
  await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  // Same arming delay as the source watcher (see fs-watch.ts): the OS watch lags `ready` slightly.
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  return {
    async stop() {
      stopped = true;
      await watcher.close();
    },
  };
}
