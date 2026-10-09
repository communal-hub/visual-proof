import { DecisionBudget } from './budget.js';
import { API_KEY_ENV, DecisionsClient, loadApiKey, type DecisionsApi, type DecisionStats } from './client.js';
import { decisionsActive, type DecisionsConfig } from './config.js';

export interface RuntimeOptions {
  config: DecisionsConfig;
  env: NodeJS.ProcessEnv;
  /** Directory of the config file: a `.env` next to it may hold the key. */
  configDir: string;
  /** Replaces the real client (tests). Counts as having a key. */
  client?: DecisionsApi;
  /** An absolute time (ms) no decision phase may run past (finish's own deadline). */
  capAt?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/** The decisions of one `finish` (or one watcher): the client, whether it is allowed to be used, and the shared time budget. */
export class DecisionRuntime {
  readonly client: DecisionsApi | null;
  /** `enabled: true` was configured but there is no key: `finish` says decisions are not running. */
  readonly missingKey: boolean;
  private spentMs = 0;
  private readonly now: () => number;

  constructor(private readonly options: RuntimeOptions) {
    this.now = options.now ?? Date.now;
    let client: DecisionsApi | null = null;
    let hasKey = false;
    if (options.client) {
      client = options.client;
      hasKey = true;
    } else {
      const key = loadApiKey(options.env, options.configDir);
      if (key) {
        hasKey = true;
        client = new DecisionsClient({ apiKey: key.key, log: options.log });
      }
    }
    this.missingKey = options.config.enabled === true && !hasKey;
    this.client = decisionsActive(options.config, hasKey) ? client : null;
  }

  get config(): DecisionsConfig {
    return this.options.config;
  }

  get active(): boolean {
    return this.client !== null;
  }

  get log(): ((message: string) => void) | undefined {
    return this.options.log;
  }

  get stats(): DecisionStats {
    return this.client?.stats ?? { requests: 0, failed: 0, retries: 0, ms: 0, cost: 0, inputTokens: 0 };
  }

  /** Wall time spent inside decision phases (not the waits between them). */
  get ms(): number {
    return this.spentMs;
  }

  /**
   * Run one phase of decisions against what is left of the budget. The clock only runs inside phases, so a
   * `finish` that waits for the watcher between two of them does not lose budget.
   */
  async phase<T>(fn: (budget: DecisionBudget) => Promise<T>): Promise<T> {
    const left = Math.max(0, this.options.config.budgetMs - this.spentMs);
    const budget = new DecisionBudget(left, this.now, this.options.capAt);
    budget.start();
    try {
      return await fn(budget);
    } finally {
      this.spentMs += budget.elapsedMs();
      budget.dispose();
    }
  }

  /** Start a new budget (the watcher does this per batch; `finish` has one runtime per run). */
  reset(): void {
    this.spentMs = 0;
  }

  get exhausted(): boolean {
    return this.spentMs >= this.options.config.budgetMs;
  }

  /** The note for `enabled: true` without a key. */
  get missingKeyNote(): string {
    return `decisions are enabled but ${API_KEY_ENV} is not set (environment or .env next to the config); using DOM heuristics only`;
  }
}
