import picomatch from 'picomatch';
import type { Config } from './config.js';

export interface FileClassifier {
  /** Matches `screenGlobs` and not `ignoreScreenGlobs`. */
  isScreen(file: string): boolean;
  isBackend(file: string): boolean;
}

/** The screen/backend split shared by the watcher, `finish` and `doctor`, so they cannot disagree. */
export function classifier(globs: Pick<Config, 'screenGlobs' | 'backendGlobs' | 'ignoreScreenGlobs'>): FileClassifier {
  const screen = picomatch(globs.screenGlobs, { dot: true });
  const ignored = picomatch(globs.ignoreScreenGlobs, { dot: true });
  const backend = picomatch(globs.backendGlobs, { dot: true });
  return {
    isScreen: (file) => screen(file) && !ignored(file),
    isBackend: (file) => backend(file),
  };
}
