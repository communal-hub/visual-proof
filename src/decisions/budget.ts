/**
 * The time all decisions of one `finish` (or one watch batch) share. The clock starts the first time anything
 * asks about it, so work done before the first decision (waiting for the daemon) does not eat the budget.
 * `signal` aborts when the deadline passes, which cancels in-flight requests and their retry back-off.
 */
export class DecisionBudget {
  private startedAt: number | null = null;
  private deadline = Number.POSITIVE_INFINITY;
  private timer: NodeJS.Timeout | undefined;
  private readonly controller = new AbortController();

  constructor(
    readonly totalMs: number,
    private readonly now: () => number = Date.now,
    /** An absolute time (ms) the budget may never run past, e.g. finish's own deadline. */
    private readonly capAt: number = Number.POSITIVE_INFINITY,
  ) {}

  /** Start the clock (idempotent) and return the abort signal. */
  start(): AbortSignal {
    if (this.startedAt === null) {
      this.startedAt = this.now();
      this.deadline = Math.min(this.startedAt + this.totalMs, this.capAt);
      const left = this.deadline - this.startedAt;
      if (left <= 0) this.controller.abort();
      else {
        this.timer = setTimeout(() => this.controller.abort(), left);
        this.timer.unref?.();
      }
    }
    return this.controller.signal;
  }

  get signal(): AbortSignal {
    return this.start();
  }

  remainingMs(): number {
    this.start();
    return Math.max(0, this.deadline - this.now());
  }

  expired(): boolean {
    return this.remainingMs() <= 0 || this.controller.signal.aborted;
  }

  /** Shorten the budget to at most `ms` from when the clock started (starts it). Never lengthens it. */
  capTo(ms: number): void {
    this.start();
    const deadline = Math.min(this.deadline, (this.startedAt ?? this.now()) + ms);
    if (deadline >= this.deadline) return;
    this.deadline = deadline;
    clearTimeout(this.timer);
    const left = deadline - this.now();
    if (left <= 0) this.controller.abort();
    else {
      this.timer = setTimeout(() => this.controller.abort(), left);
      this.timer.unref?.();
    }
  }

  /** Milliseconds since the clock started (0 before). */
  elapsedMs(): number {
    return this.startedAt === null ? 0 : this.now() - this.startedAt;
  }

  /** Resolve with `promise`'s value, or `'timeout'` when the deadline passes first (for work that ignores the signal). */
  async race<T>(promise: Promise<T>): Promise<T | 'timeout'> {
    const signal = this.start();
    promise.catch(() => {});
    if (signal.aborted) return 'timeout';
    let onAbort: (() => void) | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
      onAbort = () => resolve('timeout');
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([promise, expired]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
