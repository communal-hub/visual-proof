# Changelog

## 0.13.0

Visual proof stops being the bottleneck of an agent run. In 10 Devin ticket sessions on v0.11/v0.12 it took about
162 of 258 minutes to a ready PR, nearly all of it waiting on captures that decided nothing (impact routes of a
shared component, batches thrown away by a regenerated file). Consumers that set `finishBudgetMs: 180000` and
`focus.maxImpact: 15` as a stopgap can go back to the defaults (`maxImpact` 40) and use `ready --claim`.

### New commands

- `visual-proof ready --claim` (and `status --wait --claim`): returns once every screen the claim names has a clean
  frame that stands at the current tree, ignoring impact routes and later batches. It asks the watcher to look at the
  claim screens at once, fails fast when a claim screen is not clean, unfilled or the claim names none, and on a
  timeout says what is outstanding (`claim: 1/2 captured; impact: 31 queued`). Plain `ready` names the queued work
  on a timeout too.
- `visual-proof sidecar try <file> [--json]`: replays one sidecar scenario now against the running app, without the
  watcher, a commit or a frame record. Prints each step with its line, result and time, the still paths, and exits 1
  on a failed step or a still that is not clean.
- `visual-proof before --claim [--working-tree-sidecars]`: captures the claim screens at the merge-base whatever the
  diff, so it can run in the background before and during the edits. `--working-tree-sidecars` replays uncommitted
  sidecars as they are on disk; without it they are skipped with a note (they used to be skipped silently).
- `visual-proof classify [paths...] [--json]`: whether files need proof (screen, backend, sidecar) and the screens
  they reach, by the watcher's own rules; without paths, the branch's changed files. Replaces hand-kept copies of the
  rules in PR gates.

### New config keys

- `finishWaitMs` (default 150000): how long `finish` waits for the watcher to capture the headlines.
  `finishBudgetMs` (default 25000, unchanged) no longer includes that wait: it covers `finish`'s own work (frames,
  decisions, replay). `finish --hook` waits at most `finishBudgetMs`.
- `backendScope` (`"session"` default, or `"claim"`): with `"claim"`, a backend change re-captures the claim screens
  and the batch's own routes instead of every route and sidecar captured this session.
- `focus.impactConcurrency` (default 2, 1 to 4): impact routes captured side by side. Claim screens and other
  headlines are captured one at a time and first.

### Watcher

- Claim screens first: a batch captures the claim's routes, then the sidecars with a claimed still, records them and
  updates `status.json`, before the other headlines and the impact routes.
- Preemption: the non-claim part of a batch stops between captures when new work arrives (a save, a new claim screen,
  a claim request); the rest moves to the next batch, behind its claim screens.
- `status.json` gains `claim` (per claim screen: `clean`, `carried`, `not-clean`, `queued`, `missing`, `unfilled`,
  `unmatched`, plus `ready`, `current`, `tree`, `request`), `remaining` (`{ claim, headline, impact }` left in the
  running batch) and `repoDir`.
- `claim-request.json` in the status dir: `ready --claim` and `finish` write it to have the claim screens captured
  ahead of impact routes.
- Saves that change nothing are ignored: events are compared by content (git blob ids from the starting tree, then
  the last seen content), so a touch, an amend or a regeneration that writes identical bytes starts no batch and makes
  no frame stale.
- A change during a capture that touched only sidecar files never discards route frames, even without an import graph.
- Claim screens whose clean frame is at an earlier tree that nothing changed since can reach are not re-captured.
- The browser shares one login and one context launch between concurrent captures.

### finish

- Waits only for headlines; a headline whose earlier frame carries to HEAD is not waited for. Writes a claim request
  while it waits. The failure after the wait names what was missing and what was queued.
- Impact routes skipped under `backendScope: "claim"` are listed as such, not as missing.

### Fixes

- On a branch with no commits of its own yet (HEAD at the merge-base), `finish` and `before` no longer diff the base
  branch's last commit (`HEAD~1..HEAD`); an empty `main...HEAD` is trusted on a named branch other than the base.
- `before` skips screens that already have a before frame at the merge-base tree, and starts no dev server when all
  of them do.
- Scenario results carry per-step timings.

Earlier versions: see the git history and the tags.
