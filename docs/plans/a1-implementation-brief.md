# A1 implementation brief

Companion to `visual-proof-plan.md`. This file pins down the contracts that milestone A1 builds against. The plan is the authority on intent; this brief is the authority on names, formats, and layout.

## Deviation from the plan

The plan's Tier 1 trigger is the browser console line `[vite] hot updated: <path>`. Two Vite facts rule that out as the sole trigger:

- Vite 8's client only logs that line for modules already loaded by the open page (`hotModulesMap.get(path)` in `vite/dist/client/client.mjs`), so a listener page misses other routes.
- The Vite server only sends HMR messages for modules already in its module graph, so a page nobody has loaded since the server started produces no message at all. In that case nothing is cached either, so a fresh navigation cannot be stale.

The A1 design:

- **Trigger:** a file watcher (chokidar) on `screenGlobs` and `backendGlobs`, debounced (150 ms). This is always on.
- **Freshness barrier:** a **Vite HMR websocket client** in Node. After a screen-file event, wait for the next HMR message (`update` or `full-reload`) or 500 ms, whichever comes first. The message arrives after Vite has invalidated the module; the timeout covers modules not yet in Vite's graph, which have no cached transform.
  - Fetch `<viteUrl>/@vite/client`, read the token with `/const wsToken = "([^"]+)"/`.
  - Connect to `ws(s)://<vite host>/?token=<token>` with subprotocol `vite-hmr`. Reconnect with backoff, re-fetching the token (a restarted dev server has a new one).
- **Capture:** every capture opens a **fresh page** in the warm context and navigates, so the still cannot show a pre-update render. No Vite plugin, no app config change.
- **Tree stability:** compute the tree hash before and after a capture batch. If it changed mid-batch, discard the batch; the newer change has already queued another.
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
  git.ts            tree hash, HEAD tree, changed files
  trigger/
    vite-hmr.ts     freshness barrier: HMR websocket client
    fs-watch.ts     trigger: screen + backend globs
  resolve/
    import-graph.ts static import graph from route files -> file-to-routes map
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
  "screenGlobs": ["src/**/*.vue"],
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
  "maxFrames": 200,
  "finishBudgetMs": 25000,
  "baseRef": "main"
}
```

Env overrides: `VISUAL_PROOF_ARTIFACT_DIR` (default `/opt/cursor/artifacts`), `VISUAL_PROOF_STATUS_DIR` (default `/tmp/cursor/visual-proof`), `VISUAL_PROOF_SCRATCH_DIR` (default `<statusDir>/scratch`).

## Files the daemon writes (status dir)

- `daemon.pid`: pid as text.
- `status.json`: `{ state: "starting"|"ready"|"capturing"|"error"|"stopped", sessionId, pid, startedAt, trigger: "fs-watch", barrier: "vite-hmr"|"timeout-only", anchor, lastCaptureAt, lastError, frames }`. `pid` is the watcher process; `anchor` is the `HEAD` commit sha when the watcher started (null outside a repo or with no commits). `finish` adds `lastFinish` to the same file.
- `watcher.log`: one line per event, ISO timestamp first.
- `doctor.json`: resolved tier per capability.
- `proof-block.md`: written by `finish`.
- `scratch/index.jsonl` + `scratch/frames/<id>.png`.

## Frame record (one JSON line in index.jsonl)

```json
{ "id": "f-000042", "sessionId": "s-...", "route": "/invoices/1", "routeKey": "/invoices/:id",
  "at": "2026-10-08T12:00:00.000Z", "treeHash": "<40 hex>", "trigger": "screen|backend",
  "sourceFile": "src/pages/Invoice.vue", "status": "clean|loading|error|blank",
  "reasons": ["console error: ..."], "png": "frames/f-000042.png" }
```

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

Capture waits: `load`, then network idle (500 ms, capped at 5 s), `document.fonts.ready`, two `requestAnimationFrame`s. Reduced motion on. Fixed clock is A2+.

## finish semantics

1. Changed files = the committed diff plus uncommitted changes, with paths relative to the config directory (git reports toplevel-relative paths; `git rev-parse --show-prefix` is stripped and anything outside the config directory dropped). The committed diff is the first of these that yields files: `<baseRef>...HEAD` (or `origin/<baseRef>...HEAD`), then `<anchor>..HEAD` (the `anchor` in `status.json`), then `HEAD~1..HEAD`. An empty `<baseRef>...HEAD` is not trusted: working directly on the base branch makes it empty even after commits. The range used is printed in the proof block notes (`diffed <range>`). If no changed file matches `screenGlobs` or `backendGlobs`, write an empty proof block (an HTML comment naming the range), print `no screen changes`, exit 0.
2. Expected routes = routes resolved from the changed screen files, plus every route captured this session when a backend file changed.
3. For each expected route: the headline is the latest frame with `treeHash == HEAD^{tree}`.
   - No such frame → failure `no frame at HEAD for <route>`.
   - Headline status not `clean` → failure `<route> final frame is <status>`. Never fall back to an earlier clean frame.
4. Copy headlines to the artifact dir as `<slug>-<shortTree>.png`. Write `proof-block.md` with one `<img>` per route, plus the route, status, and tree hash.
5. Exit 1 on any failure (proof block still written, failures listed in it). Exit 0 otherwise.
6. `--hook`: same work, capped at `finishBudgetMs`, never prints to stdout except one summary line, always exits 0, writes failures to `watcher.log` and `status.json`.

## Known-bad corpus (A1 Done gate)

Each is an integration test against the fixture, using real Chromium and a real Vite dev server, inside a throwaway git repo copied from the fixture. `finish` must exit 1 and name the failure:

| Case | Setup | Expected failure |
| --- | --- | --- |
| wrong-route | Change a page whose route was never captured (watcher stopped before the edit, then commit) | `no frame at HEAD for <route>` |
| broken-final-save | Save a good edit (clean frame), then a breaking edit (throws on mount), then commit | `<route> final frame is error` |
| backend-only | Change the fixture's server data file; fs watcher must re-capture; test that finish passes with the new data visible, and fails if the watcher is disabled | pass with watcher / `no frame at HEAD` without |
| stale-bundle | Remove the freshness marker, then save | capture refused; `finish` reports `no frame at HEAD` |
| other-tree | Edit, capture, then revert the edit without a capture, commit | `no frame at HEAD for <route>` |

Plus one happy path: edit → clean frame → commit → `finish` exits 0 with a valid proof block.

## Fixture app (fixtures/vite-vue)

- Vite + Vue 3 + vue-router 4. `src/router/index.js` statically imports page components and maps them to paths, including one param route (`/invoices/:id`).
- A shared component used by two pages (for fan-out).
- `#app` root. A `.spinner` element shown while data loads.
- Dev-only Vite middleware (in the fixture's own `vite.config.js`) that serves:
  - `GET /api/invoices` and `GET /api/invoices/:id` from `server/data.json` (the "backend"; re-read on every request).
  - `POST /__playwright__/login` that requires the `X-Visual-Proof-Token` header to match `.visual-proof/token`, then sets a session cookie. Pages under `/manage/*` redirect to `/login` without that cookie.
- The fixture writes its own `public/hot`-style marker on server start (`.visual-proof/hot`) so the freshness check is testable.
- A `visual-proof.config.json` for the fixture.
