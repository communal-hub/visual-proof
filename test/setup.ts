// The suite must be deterministic and offline: a key in the developer's shell must not turn decisions on in
// tests that never asked for them. Live tests (test/live/**) read the key through test/live.ts, which looks at
// VP_LIVE_OPENROUTER_API_KEY first and then at the worktree's gitignored .env.
if (process.env.OPENROUTER_API_KEY) {
  process.env.VP_LIVE_OPENROUTER_API_KEY ??= process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
}
