/** Process exit codes, shared by every command and documented in `--help`. */
export const EXIT = {
  /** Success (for `finish`: proof assembled and every route clean). */
  OK: 0,
  /** `finish` found proof failures; `doctor` found the browser or the trigger missing. */
  FAILURES: 1,
  /** Bad command line. */
  USAGE: 2,
  /** Setup or config problem: invalid or missing config, not a git repo, the watcher cannot start. */
  SETUP: 3,
  /** A bug or an unexpected environment error. */
  INTERNAL: 4,
} as const;
