# visual-proof

Visual proof for agent-made UI changes. A background watcher keeps a headless Chromium
warm, re-captures the affected screens of a Vite dev app every time you save, and
`finish` turns the result into a proof block (headline stills plus a markdown summary)
for HEAD. It fails loudly when a changed screen has no clean frame at HEAD.

Status: A1 (capture core), the v0.3 capture-quality work and the v0.4 robustness and latency work (list-endpoint params, flake controls, tunable settle). Vite apps only; Chromium only.

## Install

Pin a tag or commit as a git devDependency. The package builds itself on install
(`prepare` runs `tsc`).

```json
{
  "devDependencies": {
    "visual-proof": "github:communal-hub/visual-proof#<tag-or-sha>",
    "playwright": "^1.57.0"
  }
}
```

`playwright` is a peer dependency (`>=1.57.0 <2`): the app's own copy is used, so there
is a single Playwright install. Then fetch the browser once:

```sh
npx playwright install chromium
```

Requires Node 20+.

## Configure

Create `visual-proof.config.json` in the app repo root (or pass `--config <path>`).
Only `appUrl` is required.

```json
{
  "appUrl": "http://localhost:5173",
  "routeFiles": ["src/router/**/*.{js,ts}"],
  "screenGlobs": ["src/**/*.vue"],
  "backendGlobs": ["server/**"],
  "routeParams": { "/invoices/:id": "/invoices/1" }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `appUrl` | required | where pages are loaded |
| `viteUrl` | `appUrl` | Vite dev server, source of HMR messages |
| `freshnessMarker` | none | file that must exist before a capture (e.g. a "hot" file written by the dev server) |
| `ignoreHTTPSErrors` | `false` | accept self-signed certificates |
| `viewport` | `1280x800` | `{ width, height }` |
| `routeFiles` | `src/router/**/*.{js,ts}` | roots of the static import graph that maps screen files to routes |
| `srcRoots`, `aliases` | `["src"]`, `{ "@": "src" }` | how imports resolve |
| `staticRoutes` | `{}` | file to routes, for screens the graph cannot reach |
| `routeParams` | `{}` | concrete URL for a parametrised route |
| `routeParamsFile` | none | JSON file of route params the app writes at runtime (e.g. a seeder), relative to the config dir; see below |
| `paramSources` | `{}` | route key to `{ url, pick }`: fill a route's params from a list endpoint when nothing above has them; see below |
| `screenGlobs` | `src/**/*.vue` | files whose changes trigger a capture |
| `ignoreScreenGlobs` | `[]` | files that match `screenGlobs` but are not screens |
| `backendGlobs` | `[]` | backend files; a change re-captures routes already captured this session (as does a screen file with no route) |
| `login` | `{ "type": "none" }` | `http-hook`: `url`, `email`, `tokenHeader`, `tokenFile` |
| `appRoot` | `#app` | element that must have children, else the frame is `blank` |
| `spinnerSelectors` | `[".spinner", "[aria-busy=true]"]` | a visible match marks the frame `loading` |
| `warmupRoutes` | first graph route without unfilled params, else `/` | routes visited before `ready` so Vite compiles and optimizes first; route keys or concrete paths; `[]` disables; see below |
| `warmupBudgetMs` | `60000` | total time the warm-up may take |
| `scrollContainer` | auto-detected | CSS selector of the element that scrolls inside the page |
| `maxCaptureHeight` | `6000` | stills taller than this (CSS px) are cut off here |
| `hideSelectors` | see below | extra selectors hidden (`visibility: hidden`) in stills; added to the defaults |
| `hideSelectorsReplace` | `false` | `true`: `hideSelectors` replaces the defaults instead of extending them |
| `renderCheck` | `"fail"` | `fail`, `warn` or `off`: whether a changed `.vue` file must have rendered; see below |
| `settle` | `{ "networkIdleMs": 250, "maxWaitMs": 5000 }` | when a page counts as loaded: no request in flight for `networkIdleMs`, waiting at most `maxWaitMs`; see "Settle and latency" |
| `fixedTime` | none (time is not frozen) | ISO timestamp the page clock is frozen at; see "Flake controls" |
| `maskSelectors` | `[]` | Playwright selectors covered by a solid box in stills |
| `blockHosts` | analytics and trackers, see below | hostname globs whose requests are aborted before navigation (replaces the default list; `[]` blocks nothing) |
| `allowHosts` | `[]` | hostname globs exempt from `blockHosts` |
| `maxFrames` | `200` | oldest frames are evicted beyond this |
| `finishBudgetMs` | `25000` | how long `finish` waits for in-flight captures |
| `baseRef` | `main` | branch that `finish` diffs against |

### Route params from a seed file

When the ids of a parametrised route only exist after the app seeds its data, point
`routeParamsFile` at a JSON file the seeder writes. Either shape works:

```json
{ "routes": { "/manage/invoices/:id": "/manage/invoices/42" } }
```

```json
{ "/manage/invoices/:id": "/manage/invoices/42" }
```

- Entries from the file override `routeParams` for the same key; other keys merge.
- The file is re-read whenever params are needed (watch batches, `finish`, `doctor`), so a
  file written after the watcher started is picked up without a restart.
- A missing file counts as empty (`doctor` warns `routeParamsFile not found: <path>`).
  Invalid JSON or a wrong shape is an error in `doctor`, a one-line warning in
  `watcher.log`, and a note in the `finish` proof block; `routeParams` from the config
  still apply.
- Values must be strings starting with `/`; others are ignored with a warning.
- `doctor` reports the `params` capability as `seed-file`, `config`, or `none`. It is
  never required.

### Route params from list endpoints

Third tier, after `routeParams` and `routeParamsFile`: for a parametrised route that neither of them
fills, the watcher asks the app for a real id.

```json
{
  "paramSources": {
    "/manage/invoices/:id": { "url": "/api/invoices", "pick": "data.0.id" },
    "/accounts/:id/:tab": { "url": "/api/accounts", "pick": { "id": "0.uuid", "tab": "'invoices'" } }
  }
}
```

- `url` is an app-relative API path (starts with `/`), fetched with the watcher's logged-in browser
  context: the same cookies and `ignoreHTTPSErrors` as captures, re-logging in once on a 401/403.
- `pick` is a dot path into the JSON: object keys and array indexes (`data.0.id`, `0.uuid`). A quoted
  value (`'invoices'`, `"invoices"`) is a literal. A route with one param takes a string; any route
  may take an object of param name to pick, and a route with several params must (all of them, no
  extras). The picked value must be a non-empty string or a finite number, and is URL-encoded into the path.
- Resolved lazily, when a route needs params and `routeParams` / the seed file have none (the
  warm-up does the same for explicit `warmupRoutes` entries). A successful lookup is cached for the
  session; a backend-triggered recapture drops the cache, so a re-seeded database gives the new id.
  A failed lookup is not cached: the next batch tries again.
- A failure (connection error, non-2xx status, body that is not JSON, path that is missing, value
  that is not a string or number) skips that route. The reason is logged as
  `warning: paramSources /api/invoices failed: HTTP 500 (route /manage/invoices/:id)` and kept in
  `status.json` under `paramSources`. If the route then has no frame at HEAD, `finish` fails with the
  usual `cannot capture <route key>: ... (add routeParams)` line carrying that reason; with a frame
  at HEAD it proves that frame, whichever id it used.
- `doctor` has a `paramTiers` row (never required): how many routes with params each tier covers
  (`config`, `seed-file`, `list-endpoint`, `uncovered`), and one bounded probe of each source, as the
  logged-in user, when the app answers (`probe /api/invoices -> /manage/invoices/1`). With the app
  down it says the sources were not probed.

## Capture quality

**Warm-up.** A cold Vite dev server compiles pages and optimizes dependencies on first load, which
can take many seconds and reloads the page while it does. After login and before reporting `ready`
the watcher visits the warm-up routes (no stills), loads them again once if Vite reloaded the page,
and logs `warmup: done in <ms> ms (...)`. `status.json` has `state: "starting"` and
`warmup.state: "running"` meanwhile. The warm-up is bounded by `warmupBudgetMs`; any failure is
logged and startup carries on. Saves during the warm-up are queued and captured once `ready`.
`warmupRoutes` entries are route keys (`/invoices/:id`, resolved through `routeParams` and
`routeParamsFile`) or concrete paths; an entry whose params cannot be filled is skipped.

**Full-page stills of inner scroll containers.** Many apps scroll inside their own element while
`html` and `body` stay put, so a plain full-page screenshot ends at the fold. Before the screenshot
the page is prepared: the element that really scrolls (`scrollContainer`, else the largest element
with `overflow-y: auto|scroll` whose overflow is larger than the document's and that covers at
least half the viewport width and a quarter of its height) and its ancestors are set to
`height: auto; max-height: none; overflow: visible` (fixed or absolute ancestors become `relative`),
so the document grows to the content. Sticky headers appear once, at the top. The still keeps the
viewport width and is cut off at `maxCaptureHeight`. The pages are closed afterwards, so nothing is
restored.

**Hidden dev overlays.** These selectors are set to `visibility: hidden !important` (with their
descendants) right before the screenshot; add your own with `hideSelectors` or start from scratch
with `hideSelectorsReplace: true`:

| Selector | What it is |
| --- | --- |
| `#__vue-devtools-container__` | root element of the vite-plugin-vue-devtools overlay (pill, panel, handles) |
| `.vue-devtools__anchor`, `.vue-devtools-frame` | the floating pill and the panel, by class |
| `#vue-devtools-anchor` | the pill's id in older vite-plugin-vue-devtools releases |
| `#__vue-devtools-component-inspector__` | @vue/devtools-kit component-inspector highlight |
| `.vue-inspector-container` | vite-plugin-vue-inspector's floating toggle |

`vite-error-overlay` is never hidden: an error on screen is evidence. Do not hide
`[data-v-inspector]`: vite-plugin-vue-inspector puts that attribute on every element of the app.

## Rendered-component check

A clean still can still miss the change: the route loads, but the changed component sits behind a
`v-if`, or the seeded data does not reach it. At capture time the watcher reads the mounted
Vue 3 component tree (`<appRoot>.__vue_app__`, through `subTree`, children, Suspense, KeepAlive and
Teleport) and stores each component's `__file` (set by `@vitejs/plugin-vue` in dev), made
repo-relative, as `renderedFiles` on the frame (at most 2000). With no Vue 3 app or no `__file`
(production build, non-Vue app) it stores `null`.

`finish` then requires, for each changed `.vue` screen file that resolved to routes, at least one
of those routes to have a clean headline frame whose `renderedFiles` contains it (a parent or
layout in the tree counts). Otherwise it fails:

```
src/components/Foo.vue never rendered on /foo; seed the state that shows it (RecordsVisualProofRoutes) or add it to ignoreScreenGlobs
```

A file that rendered on some routes but not others gets a note. Frames with `renderedFiles: null`
(or frames from older versions) skip the check with a note. `renderCheck: "warn"` turns the failure
into a note, `"off"` disables the check and the capture-time walk. `doctor` reports the mode as
the `renderCheck` capability.

## Flake controls

Everything here is opt-in or conservative by default, because each one changes what the still shows.

**Fixed clock.** `fixedTime` (ISO, e.g. `"2026-01-15T09:00:00Z"`) freezes `Date.now()` and `new Date()` in
every page, from before the first script runs, with Playwright's `clock.setFixedTime`; timers and
animation frames keep running. It is off by default: relative dates ("3 days ago") are part of what
you may want to see. A Playwright without the clock API (older than 1.45, below this package's
peer floor) logs `fixedTime ignored` once and carries on.

**Masks.** `maskSelectors` are Playwright selectors (CSS, `text=...`, ...); each match is covered by a
solid magenta box in the still. The element keeps taking part in the layout, so nothing moves. A
selector that matches nothing is ignored; one Playwright cannot parse is logged once and skipped.

**Third-party blocking.** Requests to blocked hosts are aborted before the page navigates, so late
trackers cannot change a still or add noise. Chromium's resulting `net::ERR_FAILED` "Failed to load
resource" line is not counted as a console error. (A script that depends on the blocked one can
still throw its own error, which does count.) The default `blockHosts` is analytics and trackers only:

```
*.google-analytics.com  *.googletagmanager.com  *.posthog.com  *.segment.io
*.hotjar.com            *.intercom.io           *.sentry.io
```

Stripe, maps, fonts and CDNs are deliberately not blocked: they shape the layout. Globs match the
hostname: `*` is any run of characters, and `*.example.com` also matches `example.com`. The app's own
hosts (`appUrl`, `viteUrl`) are never blocked. To block more, list the defaults you want plus the new
hosts (a configured `blockHosts` replaces the defaults):

```json
{
  "blockHosts": ["*.google-analytics.com", "*.googletagmanager.com", "*.sentry.io", "js.stripe.com", "maps.googleapis.com"],
  "allowHosts": ["browser.sentry.io"]
}
```

`allowHosts` carves exceptions out of the list; `"blockHosts": ["*"]` with an `allowHosts` list blocks
everything but the app and the listed hosts; `"blockHosts": []` blocks nothing.

## Settle and latency

A page counts as loaded when `load` has fired, no request has been in flight for `settle.networkIdleMs`
(default 250), fonts are ready and two frames have painted. `settle.maxWaitMs` (default 5000) caps the
wait for a page that never goes quiet (long polling, event streams). The same window is used again
after the page was grown for a full-page still, capped at 1.5 s.

The window dominates the save-to-still time. Measured on the fixture (`test/integration/settle-bench.test.ts`,
5 warm samples each, median save-to-still): 500 ms, 955 ms; 250 ms, 708 ms; 150 ms, 598 ms, with no
non-clean capture at any of them. The default is 250. An app that chains requests with a gap longer
than that (a debounced search, a fetch started from a timer) can settle too early: raise
`networkIdleMs` for it. A page caught mid-load shows a spinner or a blank root and fails `finish` as
`loading` or `blank`; content that is simply not there yet cannot be told apart, so prefer the longer
window when in doubt.

Every frame record carries `timing: { settleMs, screenshotMs }` (see the brief) to show where a slow
capture spent its time.

Environment: `VISUAL_PROOF_STATUS_DIR` (default `/tmp/cursor/visual-proof`),
`VISUAL_PROOF_ARTIFACT_DIR` (default `/opt/cursor/artifacts`), `VISUAL_PROOF_SCRATCH_DIR`,
`VISUAL_PROOF_APP_URL`, `VISUAL_PROOF_VITE_URL`.

## Commands

```sh
npx visual-proof doctor     # check browser, trigger, HMR barrier, login, routes, param tiers
npx visual-proof start      # start the watcher (reattaches if running); prints status JSON
npx visual-proof status     # status JSON; a dead watcher is reported as stale
npx visual-proof status --wait [--timeout <s>]   # block until ready (alias: npx visual-proof ready)
npx visual-proof finish     # after committing: write the proof block, print its path
npx visual-proof stop
npx visual-proof watch      # run the watcher in the foreground
```

Options: `--config <path>`, `--json` (finish, doctor), `--normalize` (doctor --json), `--hook` (finish: quiet,
time-capped, always exits 0), `--wait` and `--timeout <s>` (status). Run
`npx visual-proof --help` for details.

`doctor --json --normalize` prints the report with everything that varies between runs and machines
replaced: `at` becomes `<timestamp>`; the repo, status, scratch and artifact dirs, the temp dir and the home
dir become `<repo>`, `<status-dir>`, `<scratch-dir>`, `<artifact-dir>`, `<tmp>`, `<home>`; ports after a host
become `<port>`; 7 to 40 hex digits become `<hash>`; `123 ms` becomes `<n> ms`; `Chromium 130.0.1`
becomes `Chromium <version>`. Check the output into your repo as a golden file and diff it in CI. (The
`doctor.json` on disk keeps the real values.)

`start` returns once the watcher is `ready`, or after 15 s if it is still warming up (status
`starting`, `warmup.state: "running"`). To block until the first capture can be trusted, run
`status --wait` (or `ready`): it exits 0 when the state is `ready` with `pending: false`, and 1
with a one-line reason on stderr (plus the `status.json` and `watcher.log` paths) when the state is
`error`, the watcher died or was stopped, or `--timeout` (default 300 s) passed. stdout is always
the status JSON.

| Exit | Meaning |
| --- | --- |
| 0 | ok (`finish`: every changed screen has a clean frame at HEAD, or none changed) |
| 1 | `finish`: proof failures; `doctor`: browser or trigger missing; `status --wait` / `ready`: not ready |
| 2 | usage error |
| 3 | setup or config error (invalid config, not a git repo, watcher cannot start) |
| 4 | internal error |

`finish` never falls back to an earlier clean frame: the final frame of each expected
route at HEAD must be `clean`. Failures and remedy hints go to stderr and into the proof
block.

A changed screen file that maps to no route still fails `finish` (add `staticRoutes` or
`ignoreScreenGlobs`), but the watcher now re-captures every route captured this session when one
changes, exactly as for a backend change, so the other frames stay at HEAD. The diff anchor
(`anchor` in `status.json`, the commit `finish` diffs from when the base ref gives nothing) is kept
in `anchors.json` keyed by repo root and branch: a restarted watcher on the same branch reuses the
earliest anchor while it is still an ancestor of HEAD and less than 24 h old, otherwise it starts
over from HEAD.

## Files written

In the status dir:

- `daemon.pid`, `status.json` (state, warm-up, pending work, anchor, last error, last finish)
- `anchors.json` (the diff anchor per repo root and branch; survives daemon restarts, entries expire after 24 h)
- `watcher.log` (one line per event)
- `doctor.json` (last doctor report)
- `proof-block.md` (written by `finish` on every outcome)
- `scratch/index.jsonl` (one frame record per line, with `timing`) and `scratch/frames/<id>.png`

Headline stills are copied to the artifact dir as `<route-slug>-<shortTree>.png`.

## Planned (A4)

OpenRouter-backed model decisions (reviewing frames beyond the DOM heuristics) are
planned for milestone A4 and are not implemented.

## License

MIT, see [LICENSE](LICENSE).
