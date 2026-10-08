# A1 implementation brief

Companion to `visual-proof-plan.md`. This file pins down the contracts that milestone A1 builds against. The plan is the authority on intent; this brief is the authority on names, formats, and layout.

## Deviation from the plan

The plan's Tier 1 trigger is the browser console line `[vite] hot updated: <path>`. Two Vite facts rule that out as the sole trigger:

- Vite 8's client only logs that line for modules already loaded by the open page (`hotModulesMap.get(path)` in `vite/dist/client/client.mjs`), so a listener page misses other routes.
- The Vite server only sends HMR messages for modules already in its module graph, so a page nobody has loaded since the server started produces no message at all. In that case nothing is cached either, so a fresh navigation cannot be stale.

The A1 design:

- **Trigger:** a file watcher (chokidar) on `screenGlobs` and `backendGlobs`, debounced (150 ms). This is always on.
- **Freshness barrier:** a **Vite HMR websocket client** in Node. After a screen-file event, wait for an HMR message that covers the changed files, or 500 ms, whichever comes first. A message covers them when it is a `full-reload` (any), or an `update` whose `updates[].path` or `acceptedPath` is one of the changed screen modules (Vite URL path `/<repo-relative path>`, query and base ignored); an `update` for some other module does not count. The message arrives after Vite has invalidated the module; the timeout covers modules not yet in Vite's graph, which have no cached transform. A message that arrived up to 50 ms before the first file event counts (Vite can notice a save before the debounce ends); a re-queued batch never reuses the old batch's start time, so a message from before the discarded capture cannot satisfy its barrier.
  - Fetch `<viteUrl>/@vite/client`, read the token with `/const wsToken = "([^"]+)"/`.
  - Connect to `ws(s)://<vite host>/?token=<token>` with subprotocol `vite-hmr`. Reconnect with backoff, re-fetching the token (a restarted dev server has a new one).
- **Capture:** every capture opens a **fresh page** in the warm context and navigates, so the still cannot show a pre-update render. No Vite plugin, no app config change.
- **Warm-up (v0.3):** a cold Vite dev server compiles the first page it serves and optimizes dependencies found on first load, answering `504 Outdated Optimize Dep` and reloading the page meanwhile (~12 s on a real app). After login and before `ready` the watcher primes the warm-up routes (see Warm-up below).
- **Tree stability:** compute the tree hash before and after a capture batch, and keep a monotonically increasing counter of relevant file events in the trigger. If the hash changed, or any file event arrived between the two readings (an A -> B -> A save leaves the hash equal but the page may have rendered B), discard the batch and re-queue it (at most twice).
- `doctor` reports the trigger as `fs-watch` and the barrier as `vite-hmr` or `timeout-only`.

## Stack

- Node 20+, TypeScript, ESM, `"type": "module"`.
- Runtime deps: `playwright` (Chromium only), `ws`, `chokidar`, `picomatch`, `es-module-lexer`. Nothing else without a reason.
- Dev: `typescript`, `vitest`, `tsx`, `@types/node`, `@types/ws`.
- Build: `tsc` to `dist/`. Bin: `visual-proof` → `dist/cli.js`.
- Working package name: `visual-proof` (open decision 1 may rename it).

## Layout

```
src/
  cli.ts            arg parsing, subcommands
  config.ts         load + validate config, env overrides
  paths.ts          status/artifact/scratch dirs
  status.ts         status.json shape, reading it, pid helpers, atomic file writes
  exit.ts           exit codes
  text.ts           one-line error messages (config errors keep every field)
  globs.ts          screen/backend classification shared by watch, finish, doctor
  git.ts            tree hash, HEAD tree, changed files (and the range they came from), toplevel/branch/ancestor helpers
  anchor.ts         persistent diff anchor (anchors.json in the status dir)
  ready.ts          `status --wait` / `ready`: block until the watcher is ready
  rendered.ts       in-page Vue component-tree walker and `__file` normalisation (render check)
  trigger/
    vite-hmr.ts     freshness barrier: HMR websocket client
    fs-watch.ts     trigger: screen + backend globs
  resolve/
    import-graph.ts static import graph from route files -> file-to-routes map
    route-params.ts routeParams merged with the routeParamsFile seed file (re-read on every call)
    routes.ts       chain: import graph, then config static map, then skip+log
  browser.ts        warm Chromium, one context, login, capture(route) -> Frame
  triage.ts         DOM heuristics -> clean | loading | error | blank
  timeline.ts       scratch frames + index.jsonl, cap + evict oldest
  daemon.ts         pid file, reattach, status file, log
  watch.ts          wires trigger -> resolver -> capture -> timeline
  finish.ts         headline selection, proof block, exit codes
  doctor.ts         A1 minimum: browser launchable, trigger resolvable
fixtures/
  vite-vue/         fixture app (own package.json)
test/
  unit/             pure logic
  integration/      real Chromium + real fixture dev server
  corpus/           known-bad change scenarios
```

## Config

File: `visual-proof.config.json` in the app repo root (path overridable with `--config`). All fields optional unless marked.

```json
{
  "appUrl": "http://localhost:5173",            // required: where pages are loaded
  "viteUrl": "http://localhost:5173",           // HMR source; defaults to appUrl
  "freshnessMarker": "public/hot",              // must exist before capture; omit to skip
  "ignoreHTTPSErrors": false,
  "viewport": { "width": 1280, "height": 800 },
  "routeFiles": ["src/router/**/*.{js,ts}"],    // import-graph roots
  "srcRoots": ["src"],                          // where component imports resolve
  "aliases": { "@": "src" },
  "staticRoutes": { "src/pages/Reports.vue": ["/reports"] },
  "routeParams": { "/invoices/:id": "/invoices/1" },
  "routeParamsFile": ".visual-proof/route-params.json", // params written at runtime by the app (e.g. a seeder); relative to the config dir
  "screenGlobs": ["src/**/*.vue"],
  "ignoreScreenGlobs": [],                      // files matching these are never screens (shared helpers, stories)
  "backendGlobs": ["server/**"],
  "login": {
    "type": "http-hook",                        // or "none"
    "url": "/__playwright__/login",
    "email": "admin@example.test",
    "tokenHeader": "X-Visual-Proof-Token",
    "tokenFile": ".visual-proof/token"          // read at login time
  },
  "appRoot": "#app",
  "spinnerSelectors": [".spinner", "[aria-busy=true]"],
  "warmupRoutes": ["/", "/invoices/:id"],       // visited before `ready`; default: first graph route without unfilled params, else "/"; [] disables
  "warmupBudgetMs": 60000,                      // total warm-up time before it is abandoned (startup still succeeds)
  "scrollContainer": "main.content",            // inner scroller to expand for full-page stills; default: detected
  "maxCaptureHeight": 6000,                     // stills are cut off at this many CSS px
  "hideSelectors": [".cookie-banner"],          // hidden in stills, added to the defaults below
  "hideSelectorsReplace": false,                // true: hideSelectors replaces the defaults
  "renderCheck": "fail",                        // "fail" | "warn" | "off": changed .vue files must have rendered
  "maxFrames": 200,
  "finishBudgetMs": 25000,
  "baseRef": "main"
}
```

`routeParamsFile` points at a JSON file of either shape `{ "routes": { "<route key>": "<concrete path>" } }` or the flat `{ "<route key>": "<concrete path>" }`. Semantics:

- Entries from the file override `routeParams` for the same key; other keys merge.
- The file is re-read whenever params are needed (watch batches, `finish`, `doctor`); nothing is cached, so a file written after the daemon started is picked up without a restart. Backend-triggered re-captures re-resolve each captured route key against the current params.
- A missing file is empty, with no error. Invalid JSON or a wrong shape never crashes: `doctor` reports an error, `watcher.log` gets a one-line `warning: ...` (repeated only when the problem changes), and `finish` adds a note; all three fall back to config `routeParams`.
- Values must be strings starting with `/`; others are ignored with a warning (same three places).
- `doctor` gains a `params` capability, never required: tier `seed-file` (`N entries from <file>`) when the file is present, else `config` (`N entries`), else `none`. A missing file is a `warn` (`routeParamsFile not found: <path>`); an unreadable or invalid file is tier `invalid`.

### Warm-up

Runs in `start()` after the trigger is live and before `state` becomes `ready`; `status.json` keeps `state: "starting"` throughout, with `warmup: { state: "running", routes: [] }`.

- Targets: each `warmupRoutes` entry resolved through `routeParams` (merged with `routeParamsFile`): a route key with a params entry becomes that path, a concrete path is used as is, an entry with unfilled params is skipped and logged. Without `warmupRoutes`: the first route of the import graph whose params are all filled, else `/`. `warmupRoutes: []` skips the warm-up. A capturer without `prime()` is not warmed up.
- Each target is loaded exactly like a capture (fresh page, `load`, network idle, settle) but not screenshotted and not recorded as a frame. If Vite reloaded the page (a main-frame navigation after the first) or a module answered `Outdated Optimize Dep`, the route is loaded once more (at most 2 passes).
- Bounded by `warmupBudgetMs` (default 60 s) in total; a visit that outlives the budget is abandoned (`warmup.state: "timeout"`). A throwing visit or a 5xx is logged and counted (`failed` when no route succeeded). Nothing here fails startup.
- Result: `status.json` `warmup: { state: "done"|"failed"|"timeout"|"skipped", ms, routes: [{ route, ms, ok, reloads?, error? }] }` and the log line `warmup: <state> in <ms> ms (<route> <ms> ms, ...)`, which precedes `ready (...)`.
- File events during the warm-up are queued (`pending: true`) and captured once `ready`.
- `start` waits for `ready` for up to 15 s; if the watcher is still warming up then, it prints the `starting` status and exits 0 (it does not kill the watcher). Use `status --wait`.

### Capture preparation

Before each screenshot (after the DOM signals are read) the page is prepared by one in-page script:

1. **Hide overlays:** `<sel>, <sel> * { visibility: hidden !important }` for each valid selector (an invalid one is skipped). Effective list = defaults + `hideSelectors` (deduplicated), or only `hideSelectors` with `hideSelectorsReplace: true`. Defaults, from the published packages: `#__vue-devtools-container__` (vite-plugin-vue-devtools 8.x root), `.vue-devtools__anchor`, `.vue-devtools-frame`, `#vue-devtools-anchor` (older releases), `#__vue-devtools-component-inspector__` (@vue/devtools-kit), `.vue-inspector-container` (vite-plugin-vue-inspector). `vite-error-overlay` is deliberately not hidden; `[data-v-inspector]` must not be (it is stamped on every app element).
2. **Find the scroller:** `scrollContainer` if set (a miss is logged and ignored), else the element among `body` and its descendants with the largest `scrollHeight - clientHeight` (> 1) whose computed `overflow-y` is `auto|scroll|overlay`, at least half the viewport wide and a quarter of its height. It is only used when its overflow exceeds the document's own (`scrollingElement.scrollHeight - innerHeight`), so a document that scrolls natively is left alone.
3. **Grow the document:** the scroller and every ancestor below `html` get `data-vp-grow`; `html, body, [data-vp-grow]` get `height: auto; max-height: none; overflow: visible` (`!important`), and ancestors that are `fixed`/`absolute` become `position: relative; inset: auto`. Sticky headers then appear once at the top; fixed ones stay where the browser puts them. `img[loading=lazy]` become eager. After growing, the page settles again (network idle capped at 1.5 s, fonts, two frames) and the height is re-measured.
4. **Cap and clip:** height = `min(max(document height, viewport height), maxCaptureHeight)`; the screenshot is `fullPage` with `clip: { x: 0, y: 0, width: viewport.width, height }`, so the width never changes and nothing below the cap is kept. Pages are closed after capture, so nothing is restored. If the script fails, a plain full-page screenshot is taken.

`CaptureResult.layout` reports `{ scrollContainer, fullHeight, height, capped, hidden }` (not stored in frames); the log notes an expanded container and a cap.

### Rendered components

When `renderCheck` is not `off`, after the page settles an in-page script (a string, because tsx `keepNames` would inject `__name` helpers into a function passed to `page.evaluate`) reads `document.querySelector(appRoot).__vue_app__`, walks from `app._instance` (an instance continues with `subTree`; a vnode with `component`, `suspense.activeBranch` and array `children`, which covers Teleport content; KeepAlive's `subTree` is its active child) and collects `type.__file` of every component. Node normalises each to a repo-relative POSIX path (relative to the config directory, so both `repoDir` and its realpath are tried), drops files outside the repo, dedupes, sorts and caps at 2000. The result is the frame's `renderedFiles`. It is `null` when there is no `__vue_app__` or no `__file` anywhere (production build, non-Vue app) or when no path lies inside the repo (paths from a different mount point cannot be compared); the check then skips.

Env overrides: `VISUAL_PROOF_ARTIFACT_DIR` (default `/opt/cursor/artifacts`), `VISUAL_PROOF_STATUS_DIR` (default `/tmp/cursor/visual-proof`), `VISUAL_PROOF_SCRATCH_DIR` (default `<statusDir>/scratch`).

## Files the daemon writes (status dir)

- `daemon.pid`: pid as text.
- `status.json`: `{ state: "starting"|"ready"|"capturing"|"error"|"stopped", sessionId, pid, startedAt, trigger: "fs-watch", barrier: "vite-hmr"|"timeout-only", anchor, lastCaptureAt, lastEventAt, pending, pendingSince, lastError, frames, warmup }`. `pid` is the watcher process; `anchor` is the diff anchor (see `anchors.json`; null outside a repo or with no commits); `warmup` is absent until the warm-up step and then `{ state: "running"|"done"|"failed"|"timeout"|"skipped", ms?, routes: [{ route, ms, ok, reloads?, error? }] }`. `state` stays `starting` until the warm-up is over. `pending` is true from the first relevant file event of a change (before the debounce ends) until its batch, including re-queues, is fully handled; `pendingSince` and `lastEventAt` are ISO timestamps (or null). `lastError` is the latest unresolved problem (a refused capture, a failed capture) and is cleared by the next fully captured batch. `finish` adds `lastFinish: { at, ok, failures, proofBlockPath, summary }` to the same file on every outcome. `status` reports a stored `starting`/`ready`/`capturing` whose watcher process is gone as `state: "stopped"`, `stale: true`, `lastError: "watcher exited without stopping"`.
- `anchors.json`: `{ "<git toplevel>\n<branch>": { anchor, at } }`. At start the watcher looks up the key (`(detached)` for a detached HEAD): a stored anchor is reused (the earliest anchor of the branch survives daemon restarts) while it is an ancestor of HEAD and less than 24 h old (so a leftover from an earlier task on the same branch name cannot widen today's diff); otherwise HEAD is stored and used. Outside a repo or without commits nothing is persisted. The log says `anchor <sha8> (HEAD|reused from an earlier session of this branch|HEAD, not persisted)`.
- `watcher.log`: one line per event, ISO timestamp first.
- `doctor.json`: resolved tier per capability.
- `proof-block.md`: written by `finish` on every outcome (a failure block when finish could not run: bad config, not a git repo, internal error), atomically (tmp + rename).
- `scratch/index.jsonl` + `scratch/frames/<id>.png`.

## Frame record (one JSON line in index.jsonl)

```json
{ "id": "f-000042", "sessionId": "s-...", "route": "/invoices/1", "routeKey": "/invoices/:id",
  "at": "2026-10-08T12:00:00.000Z", "treeHash": "<40 hex>", "trigger": "screen|backend",
  "sourceFile": "src/pages/Invoice.vue", "status": "clean|loading|error|blank",
  "reasons": ["console error: ..."], "renderedFiles": ["src/App.vue", "src/pages/Invoice.vue"],
  "png": "frames/f-000042.png" }
```

`renderedFiles`: repo-relative component files mounted in the page (see Rendered components; at most 2000), or `null` when unknown (production build, non-Vue app, `renderCheck: "off"`); absent on frames written by versions before 0.3.

Cap: when frames exceed `maxFrames`, delete the oldest records and PNGs first.

## Tree hash

`treeHash` = working-tree hash at capture time: `git add -A` into a temporary index (`GIT_INDEX_FILE` in the scratch dir, seeded from the real index) then `git write-tree`. Respects `.gitignore`. At finish, compare against `git rev-parse HEAD^{tree}`.

## Triage heuristics (A1)

In order:
1. Navigation failed or HTTP status >= 500 → `error`.
2. Any `console.error` or `pageerror` during load → `error`.
3. App root missing or has no element children → `blank`.
4. Any spinner selector visible → `loading`.
5. Otherwise `clean`.

A changed screen file that maps to no route (unmapped) re-captures every route captured this session, like a backend change (frames keep `trigger: "screen"` and `sourceFile` = the unmapped file), so frames stay at HEAD. `finish` still fails it (`no route for <file>`), unless it is ignored: an unproven file must never pass silently, and re-capturing only keeps the other routes' frames current.

Capture waits: `load`, then network idle (500 ms, capped at 5 s), `document.fonts.ready`, two `requestAnimationFrame`s. Reduced motion on. Fixed clock is A2+.

## finish semantics

1. Changed files = the committed diff plus uncommitted changes, with paths relative to the config directory (git reports toplevel-relative paths; `git rev-parse --show-prefix` is stripped and anything outside the config directory dropped). The committed diff is the first of these that yields files: `<baseRef>...HEAD` (or `origin/<baseRef>...HEAD`), then `<anchor>..HEAD` (the `anchor` in `status.json`), then `HEAD~1..HEAD`. An empty `<baseRef>...HEAD` is not trusted: working directly on the base branch makes it empty even after commits. The range used is printed in the proof block notes (`diffed <range>`). If no changed file matches `screenGlobs` or `backendGlobs`, write an empty proof block (an HTML comment naming the range), print `no screen changes`, exit 0.
2. Expected routes = routes resolved from the changed screen files (a file matching `ignoreScreenGlobs` is not a screen), plus every route captured by the current daemon session (the `sessionId` in `status.json`; all frames when there is none) when a backend file changed. Anything that cannot be turned into a capturable route is a failure, not a note:
   - a changed screen file with no route → `no route for <file> (not reachable from routeFiles; add staticRoutes or ignoreScreenGlobs)`
   - a route with unfilled params → `cannot capture <routeKey>: <reason> (add routeParams)`
   - a backend change with no captured route → `backend change (<files>) has no captured route to prove; open a page so the watcher captures it, or add staticRoutes`
3. Wait for the daemon. `finish` often runs right after the last save and commit. While a live daemon (pid alive, state not `stopped`/`error`) is `capturing`, has `pending` set, or a change newer than its `lastEventAt` is on disk (changed-file mtime under 2 s) and the working-tree hash differs from the newest frame's tree, poll every 200 ms until every expected route has a frame at `HEAD^{tree}` or the daemon is idle, bounded by the remaining `finishBudgetMs`. If the budget runs out first: failure `capture still in progress after <n> s`. No daemon, or an idle one, means the timeline is final.
4. For each expected route: the headline is the latest frame with `treeHash == HEAD^{tree}`.
   - No such frame → failure `no frame at HEAD for <route>`.
   - Headline status not `clean` → failure `<route> final frame is <status>`. Never fall back to an earlier clean frame.
   - Render check (config `renderCheck`, default `fail`; `off` skips it). For each changed `.vue` screen file that resolved to routes (via `screen`; not routes added by a backend change), consider its routes that have a `clean` headline frame (routes without one already carry a failure). If any of those frames' `renderedFiles` contains the file, it passed (a note `<file> rendered on <A> but not on <B>` when only some did; a parent or layout in the mounted tree counts as rendered). Else if some of those frames have no data (`renderedFiles` null or absent) it is skipped with a note `render check skipped for <file>: ...`. Else failure `<file> never rendered on <routes>; seed the state that shows it (RecordsVisualProofRoutes) or add it to ignoreScreenGlobs`; with `renderCheck: "warn"` the same text is a note. Only `.vue` files are checked (the only files that carry `__file`).
5. Copy headlines to the artifact dir as `<slug>-<shortTree>.png`. Write `proof-block.md` with one `<img>` per route, plus the route, status, and tree hash.
6. After failures, remedy hints are printed on stderr (`visual-proof finish: hint: ...`) and listed under `**Next steps**` in the proof block, and returned as `hints`. The failure strings above never change. Hints: the watcher is not running (`run visual-proof start`); the watcher's last problem, from `status.json` `lastError` (e.g. a refused capture); the working tree differs from HEAD (`commit your changes, then rerun finish`); the newest frame is at a different tree than HEAD (both short hashes named).
7. Exit codes: 0 ok; 1 proof failures; 3 setup or config error (invalid config, not a git repo); 4 internal error. Every outcome, including 3 and 4, writes `proof-block.md` and records `lastFinish`. A config error keeps every invalid field (flattened onto one line with `; `) on stderr and in the block.
8. `--hook`: same work, capped at `finishBudgetMs`, never prints to stdout except one summary line, always exits 0, writes failures to `watcher.log` and `status.json`.
9. `--json`: print the `FinishResult` (`ok`, `failures`, `hints`, `notes`, `routes`, `noScreenChanges`, `truncated`, `treeHash`, `range`, `proofBlockPath`, `proofBlock`, `summary`) on stdout instead of the proof block path. Exit codes are unchanged.

stdout of `finish` is the proof block path on every branch, including `no screen changes` (that message goes to stderr).

## CLI output and exit codes

| Command | stdout | exit |
| --- | --- | --- |
| `start` | status JSON plus `paths: { statusDir, proofBlock, log, doctor }` (reattaches if running) | 0; 3 config/setup (the watcher cannot start); 4 internal |
| `status` | status JSON plus `paths` | 0 |
| `status --wait [--timeout <s>]`, `ready` | status JSON plus `paths` (always); on failure also one stderr line `visual-proof status: not ready: <reason> (status: <path>, log: <path>)` | 0 when `state` is `ready` and `pending` is false; 1 when `error`, stale (watcher process gone), stopped, no watcher, or the timeout (default 300 s) passed; 2 usage |
| `stop` | status JSON | 0; 4 if the daemon cannot be signalled |
| `watch` | log lines when a TTY | 0 after SIGINT/SIGTERM; 3 config/setup |
| `finish` | proof block path (`--json`: the result; `--hook`: one summary line) | 0, 1, 3, 4 (`--hook`: always 0) |
| `doctor` | table (one row per capability, including `renderCheck`: the mode) ending `details: <doctor.json path>` (`--json`: the report) | 0; 1 when the browser or the trigger is missing; 4 internal |
| usage error | | 2 |

## Known-bad corpus (A1 Done gate)

Each is an integration test against the fixture, using real Chromium and a real Vite dev server, inside a throwaway git repo copied from the fixture. `finish` must exit 1 and name the failure:

| Case | Setup | Expected failure |
| --- | --- | --- |
| wrong-route | Change a page whose route was never captured (watcher stopped before the edit, then commit) | `no frame at HEAD for <route>` |
| broken-final-save | Save a good edit (clean frame), then a breaking edit (throws on mount), then commit | `<route> final frame is error` |
| backend-only | Change the fixture's server data file; fs watcher must re-capture; test that finish passes with the new data visible, and fails if the watcher is disabled | pass with watcher / `no frame at HEAD` without |
| stale-bundle | Remove the freshness marker, then save | capture refused; `finish` reports `no frame at HEAD` |
| other-tree | Edit, capture, then revert the edit without a capture, commit | `no frame at HEAD for <route>` |

| never-rendered | Edit a child component that the fixture page only mounts when a seeded data flag is on (flag off), capture (clean frame), commit | `<file> never rendered on <route>; seed the state that shows it ...`; passes with the flag on |

Plus one happy path: edit → clean frame → commit → `finish` exits 0 with a valid proof block.

## Fixture app (fixtures/vite-vue)

- Vite + Vue 3 + vue-router 4. `src/router/index.js` statically imports page components and maps them to paths, including one param route (`/invoices/:id`).
- A shared component used by two pages (for fan-out).
- `/long`: `src/pages/Long.vue` in `src/layouts/ScrollLayout.vue`, whose `html, body` never scroll while `main.content` (flex child, `overflow-y: auto`) holds 60 rows plus a solid green bottom marker, under a sticky header. `/flagged`: `src/pages/Flagged.vue` mounts `src/components/FlaggedDetails.vue` only when `GET /api/flags` (from `server/data.json` `flags.showDetails`, off by default) says so.
- `index.html` carries a stand-in for the devtools overlay (`#__vue-devtools-container__` holding a magenta `.vue-devtools__anchor` pill fixed at bottom-centre), so tests can check it is hidden.
- `VP_FIXTURE_CACHE_DIR` makes the fixture's Vite use its own dependency cache (cold-start tests).
- `#app` root. A `.spinner` element shown while data loads.
- Dev-only Vite middleware (in the fixture's own `vite.config.js`) that serves:
  - `GET /api/invoices` and `GET /api/invoices/:id` from `server/data.json` (the "backend"; re-read on every request).
  - `POST /__playwright__/login` that requires the `X-Visual-Proof-Token` header to match `.visual-proof/token`, then sets a session cookie. Pages under `/manage/*` redirect to `/login` without that cookie.
- The fixture writes its own `public/hot`-style marker on server start (`.visual-proof/hot`) so the freshness check is testable.
- A `visual-proof.config.json` for the fixture.
