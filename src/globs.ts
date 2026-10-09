import picomatch from 'picomatch';
import type { Config } from './config.js';

export interface FileClassifier {
  /** Matches `screenGlobs` and not `ignoreScreenGlobs`. */
  isScreen(file: string): boolean;
  isBackend(file: string): boolean;
  /** Matches the `sidecars` globs. A sidecar file is never a screen or a backend file, whatever else it matches. */
  isSidecar(file: string): boolean;
}

/** The screen/backend split shared by the watcher, `finish` and `doctor`, so they cannot disagree. */
export function classifier(
  globs: Pick<Config, 'screenGlobs' | 'backendGlobs' | 'ignoreScreenGlobs'> & { sidecars?: string[] },
): FileClassifier {
  const screen = picomatch(globs.screenGlobs, { dot: true });
  const ignored = picomatch(globs.ignoreScreenGlobs, { dot: true });
  const backend = picomatch(globs.backendGlobs, { dot: true });
  const sidecar = picomatch(globs.sidecars ?? [], { dot: true });
  const isSidecar = (file: string): boolean => (globs.sidecars?.length ?? 0) > 0 && sidecar(file);
  return {
    isScreen: (file) => screen(file) && !ignored(file) && !isSidecar(file),
    isBackend: (file) => backend(file) && !isSidecar(file),
    isSidecar,
  };
}
