# visual-proof

Visual proof for agent-made UI changes. A background watcher keeps a headless Chromium
warm, re-captures the affected screens of a Vite dev app every time you save, and
`finish` turns the result into a proof block (headline stills plus a markdown summary)
for HEAD. It fails loudly when a changed screen has no clean frame at HEAD.

Status: A1 (capture core), the v0.3 capture-quality work, the v0.4 robustness and latency work (list-endpoint params, flake controls, tunable settle) the v0.6 model decisions (A4: image check, route pruning, claim verdict, captions, via OpenRouter) the v0.7 interaction work (sidecar scenarios, replay video) and the v0.8 dynamic route params (session params, link discovery). Vite apps only; Chromium only.

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
| `paramDiscovery` | `"links"` | `links` or `off`: last tier for a route with params nothing else fills; take an id from a link on its parent page; see "Dynamic route params" |
| `sidecars` | `[".visual-proof/sidecars/*.vp"]` | globs (relative to the config dir) of sidecar scenario files; see "Sidecar scenarios" |
| `roles` | `{}` | role name to login email, for `login <role>` in a sidecar (`login default` is `login.email`) |
| `replay` | `{ "enabled": true, "maxFrames": 60, "secondsPerFrame": 1.2, "maxHeight": 1600 }` | the replay video `finish` builds when ffmpeg is on PATH; see "Replay video" |
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
| `decisions` | see "Model decisions" | OpenRouter-backed checks at bounded decision points: `enabled`, `models`, `triage`, `prune`, `verdict`, `captions`, `budgetMs` |
| `claimFile` | `<statusDir>/claim.md` | the claim the change should prove (bullet or numbered lines are criteria); relative to the config dir |

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
  `cannot capture <route key>: params unfilled. Tried: ...` failure (see "Dynamic route params") carrying that
  reason; with a frame at HEAD it proves that frame, whichever id it used. A failing source no longer ends the
  search: link discovery gets its turn.
- `doctor` has a `paramTiers` row (never required): how many routes with params each tier covers
  (`session`, `config`, `seed-file`, `list-endpoint`, `discovery`, `uncovered`), and one bounded probe of each source, as the
  logged-in user, when the app answers (`probe /api/invoices -> /manage/invoices/1`). With the app
  down it says the sources were not probed.

## Dynamic route params (v0.8)

A route like `/invoices/:id` is captured only with an id. The sources, first match wins:

1. **session params**, set by the agent with `params set` (below);
2. `routeParamsFile`, written by app seeders (it has always overridden `routeParams`);
3. `routeParams`, in the config;
4. `paramSources`, a list endpoint;
5. **link discovery**, new in v0.8 and on by default (`paramDiscovery: "links"`).

When none fills a route, `finish` fails and says what to do. Nothing in the shared config needs editing for a one-off.

### Session params: `params set | list | clear`

```sh
npx visual-proof params set '/invoices/:id' id=42
npx visual-proof params set '/clubs/:clubId/teams/:teamId' clubId=1 teamId=10
npx visual-proof params list [--json]
npx visual-proof params clear ['/invoices/:id']
```

- `set` validates the route key against the route table (the import graph of `routeFiles` plus the
  `staticRoutes` values) and the values against the pattern. Exit 2 for an unknown key (the message names the
  closest keys, and the route key a concrete path fits), for missing params, for extra ones, for a value that does
  not fit (`:id(\d+)` with `abc`, a `/` in a plain param), a malformed `param=value`, or a repeated param.
  Optional params (`:slug?`) may be left out; a repeatable one (`:path+`) takes `a/b`.
- The values are stored in `session-params.json` in the status dir (`{ version, rev, routes: { <key>: { path, params,
  at } } }`). It is never committed, outranks every other source, and stays until `params clear` (a restarted watcher
  keeps using it, but does not capture it by itself).
- **With the watcher running, `set` captures the route at once**, at the current tree, even when no changed file
  leads to it, so the agent can fix an unfilled-params failure and rerun `finish`. Mechanism: the watcher watches
  `session-params.json`; on a change it queues the routes whose entry changed as a batch (frame `trigger: "params"`),
  marks itself `pending`, and acknowledges the file revision in `status.json` as `sessionParamsRev` once the batch is
  handled. `set` waits for that acknowledgement (up to `--timeout <s>`, default 20), then prints
  `captured /invoices/42: clean (frame f-000012, tree abcd1234)`. Exit 1 when the frame is not clean or no capture
  was confirmed in time (the params stay stored); exit 0 with a note on stderr when no watcher is running.
- `list` prints the session params, the ids discovery found this watcher session (from `param-discovery.json`),
  and the **seed candidates**: routes filled by `session` or `discovered`, the records the app's seeder could create
  so no param step is needed. `--json`: `{ session: [{ routeKey, path, params, at }], discovered: [{ routeKey, path,
  foundOn, at }], seedCandidates: [{ routeKey, route, params, paramsFrom, foundOn? }], files, problems }`.

### Link discovery

For a route nothing else fills, the watcher finds the nearest parent route that is in the route table
(`/invoices/:id` -> `/invoices`, `/clubs/:clubId/teams/:teamId` -> `/clubs/:clubId/teams`), loads it in the
logged-in browser with a fresh page and the normal settle logic, and reads every `a[href]` in DOM order. The first
href that is same-origin, normalised to a path (query, hash, trailing slash and the app's base path dropped) and
fits the route's pattern wins.

- Patterns follow Vue Router: custom regex (`:id(\d+)`), optional (`?`), repeatable (`+`, `*`), params next to
  static text. A route key in the route file may write the backslash as `\\d` (it is decoded). A pattern the
  parser cannot read is not discovered.
- A candidate that is really a more specific route is skipped: `/invoices/create` is not an invoice.
- A parent with params of its own is filled through the same tiers, recursively (so discovery can go through
  `/clubs` -> `/clubs/1/teams` -> `/clubs/1/teams/10`), up to 3 ancestors deep.
- Results are cached per watcher session and dropped by a backend change, like `paramSources`, since a re-seed may
  change the ids. Failures are not cached. The cache is mirrored to `param-discovery.json` (`{ sessionId, routes: {
  <key>: { path, foundOn, at } } }`); the latest outcome per key, including the reason it failed, is in `status.json`
  under `paramDiscovery`.
- Time is bounded by the capture timeouts (30 s navigation, `settle.maxWaitMs`). The frame's `timing` gains
  `discoveryMs`.
- It finds nothing when the list is empty, when rows navigate by click handler (no `href`), or when the route has
  no parent route; the route then stays unfilled. Hash-mode routers (`/#/invoices/1`) are not supported.
- `paramDiscovery: "off"` switches it off; any other value than `links` or `off` is a config error.

Sidecar `goto <route key>` steps use the same chain, session params and discovery included.

### An unfilled route

`finish` fails with one line that names the command, the advice and what each source did:

```
cannot capture /manage/projects/:id: params unfilled. Tried: session: none set; routeParams: no entry; routeParamsFile: not configured; paramSources: not configured; discovery: no link matching /manage/projects/:id on /manage/projects. Fix: npx visual-proof params set '/manage/projects/:id' id=<value>. If no record exists, create one first (e.g. with the app's factories or seeders) and use its id.
```

`finish --json` carries the same in `unfilled: [{ routeKey, params, command, advice, tiers: [{ tier, tried, reason }] }]`.
Without a recorded discovery attempt the discovery reason is `not attempted` (or `not attempted (the watcher is not
running)`); with `paramDiscovery: "off"` it is `off (paramDiscovery: "off")`.

### Provenance and seed candidates

Every frame of a route with params records `paramsFrom`: `session`, `config`, `file`, `source` or `discovered` (and
`paramsFoundOn`, the page whose link gave the id, for `discovered`). `finish` copies both onto each route
(`routes[].paramsFrom`, `routes[].paramsFoundOn`), adds `seedCandidates` (the `session` and `discovered` routes, with
the param values) to its result, and puts one short note in the proof block for each such route
(`/manage/invoices/1: params found by link discovery on /manage/invoices`, or
`...: params set with visual-proof params set`).

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

## Sidecar scenarios

A route still shows what a page renders on load. An open modal, step 2 of a form or another role's view needs
steps. A sidecar is a short script, one file per scenario (named by its filename), that ends in stills:

```
# .visual-proof/sidecars/refund.vp
goto /manage/invoices/:id
click [data-test=invoice-refund]
wait [data-test=refund-modal]
still refund-modal
```

| Verb | Meaning |
| --- | --- |
| `goto <route key or path>` | load a page. A route key (`/manage/invoices/:id`) is filled through `routeParams`, then `routeParamsFile`, then `paramSources`; a concrete path (`/manage/invoices/1?tab=2`) is used as is. Must start with `/` |
| `click <selector>` | click the first match once it is visible. The rest of the line is the selector, spaces included |
| `fill <selector> <text...>` | fill an input. The selector is the first word (or a quoted string when it has spaces); the text is the rest of the line, or one quoted string. `""` is empty text |
| `press <key>` | press a key on the page (`Enter`, `Escape`, `Control+A`) |
| `wait <selector \| ms>` | wait until the selector is visible, or sleep `ms` (1 to 30000, `wait 500` or `wait 500ms`) |
| `still <name>` | settle the page and take a still. Names are letters, digits, `.`, `_`, `-`, unique in the file |
| `login <role>` | switch the session to that role's login email (`roles` in the config; `default` is `login.email`). A fresh session: cookies are cleared first |

Nothing else. Blank lines and lines starting with `#` are skipped (a `#` later in a line belongs to the line:
`click #submit` is an id selector). Quotes use `"..."` or `'...'` with the escapes `\\ \" \' \n \t`. A scenario
needs at least one `still`. Every problem is reported with its line (`refund.vp:3: unknown verb "clik" ...`).

**Running.** Scenarios run in the warm browser context on one fresh page, through the same settle, triage,
overlay hiding, mask and rendered-component machinery as route stills; the page is left as it was after each
still so the scenario goes on. Each `still` is a frame with `route` and `routeKey` `sidecar:<file>#<name>`,
`sourceFile` the sidecar file, and `steps` (the lines run so far). `login <role>` switches the shared session and
the default login is restored afterwards. Waits for a selector are bounded (5 s) and the whole scenario is
bounded (60 s), so a scenario never hangs.

**A failing step** stops the scenario. It becomes an `error` frame for the next `still` that was not reached
(or, when none is left, a frame named `!failed`), showing the page as the step left it, with the reason
`line 3 click [data-test=x]: selector not found`. The other reasons are `selector not visible`,
`invalid selector: ...`, `navigation failed: ...`, `cannot fill <route key>: ... (add routeParams)`,
`unknown role "..."` and `scenario exceeded 60 s`.

**When the watcher replays a scenario:** when its file changes; when a batch touches a screen file that renders
one of its `goto` routes (through the import graph, as for route stills); and, on a backend change or a screen
file with no route, when it has run this session. It goes through the same serialized queue and the same
tree-hash check as route captures. A scenario that does not parse is skipped with a `warning: sidecar ...` line
in `watcher.log`.

**finish.** A sidecar file that exists at HEAD and was touched in the diff, or visits a route that is expected
anyway, becomes expected: each of its stills needs a clean frame at HEAD's tree.

```
sidecar .visual-proof/sidecars/refund.vp still refund-modal: no frame at HEAD
sidecar .visual-proof/sidecars/refund.vp still refund-modal: final frame is error: line 3 click [data-test=x]: selector not found
sidecar .visual-proof/sidecars/refund.vp: final frame is error: line 5 click [x]: selector not found   (a step after the last still)
sidecar .visual-proof/sidecars/refund.vp:3: unknown verb "clik" (the verbs are ...)                    (does not parse)
```

The render check counts sidecar stills: a changed `.vue` file that only mounts after a click passes when a
sidecar still rendered it (`<file> rendered in sidecar <file> still <name>` note). In the proof block the stills
come after the route stills, labeled `sidecar <scenario> / <still>`. `.visual-proof/` is usually gitignored for
the token and the freshness marker; keep the scenarios: `.visual-proof/*` then `!.visual-proof/sidecars/`.

## Replay video

At `finish`, when `ffmpeg` is on PATH, the session's frames (this daemon session, in the order captured, the
latest `replay.maxFrames`, default 60) are put into `replay-<shortTree>.mp4` in the artifact dir, each shown for
`replay.secondsPerFrame` (default 1.2 s). Every frame is scaled to fit and padded onto one canvas: the viewport
width by the tallest frame, capped at `replay.maxHeight` (default 1600). A caption bar drawn by ffmpeg
(`drawtext`) names the route or `sidecar <scenario> / <still>`, the source file and the capture time (HH:MM:SS,
UTC), and flags a frame that is not clean. H.264, `yuv420p`, `faststart`, 10 fps, so it plays inline in a PR.

The proof block links it with a plain markdown link to the absolute path, like the stills:
`[Replay](/opt/cursor/artifacts/replay-1a2b3c4d.mp4) · 12 frame(s), 14.4 s`.

It only ever adds a note, never a failure: `replay skipped: ffmpeg not found`; `replay built without captions:
...` when ffmpeg has no `drawtext` filter or no font (Homebrew's default `ffmpeg` has none; `ffmpeg-full` does);
`replay skipped: ...` when there is no libx264, no frame, or the build does not fit in what is left of
`finishBudgetMs` (ffmpeg is killed when it overruns); `replay failed: <ffmpeg's last line>`. It is built only
when the proof has no failures. `replay.enabled: false` turns it off. `doctor` has a `sidecars` row (scenarios
found, parse errors) and a `replay` row (ffmpeg found, version, drawtext).

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
npx visual-proof doctor     # check browser, trigger, HMR barrier, login, routes, param tiers, decisions, sidecars, replay
npx visual-proof start      # start the watcher (reattaches if running); prints status JSON
npx visual-proof status     # status JSON; a dead watcher is reported as stale
npx visual-proof status --wait [--timeout <s>]   # block until ready (alias: npx visual-proof ready)
npx visual-proof finish     # after committing: write the proof block, print its path
npx visual-proof params set '<routeKey>' key=value ...   # use these route params now (captures at once); also: params list, params clear
npx visual-proof stop
npx visual-proof watch      # run the watcher in the foreground
```

Options: `--config <path>`, `--json` (finish, doctor, params list), `--normalize` (doctor --json), `--probe-decisions` (doctor), `--hook` (finish: quiet,
time-capped, always exits 0), `--wait` and `--timeout <s>` (status; params set). Run
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
| 1 | `finish`: proof failures; `params set`: the capture was not clean or not confirmed; `doctor`: browser or trigger missing; `status --wait` / `ready`: not ready |
| 2 | usage error |
| 3 | setup or config error (invalid config, not a git repo, watcher cannot start) |
| 4 | internal error |

`finish` carries an earlier frame forward only when nothing it depends on has changed since (edit page A, then page
B, then commit: A keeps its frame from before B's edit). The frame's tree is diffed with HEAD's; the frame goes
stale when a changed file is a backend file (`backendGlobs`), a route file (`routeFiles`), a screen file no route
renders, a screen file on one of the frame's routes, a component the frame rendered, or (for a sidecar still) its own
sidecar file. Docs, tests and config do not. A stale frame fails as before, naming the file
(`no frame at HEAD for /a (the last clean frame, at tree 1a2b3c4d, is stale: src/shared/S.vue changed since)`); a
carried one is noted (`/a carried forward from tree 1a2b3c4d: ...`) and listed as `carriedFrom` in `finish --json`.
It never falls back to an earlier clean frame behind a newer one that is not clean.

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
- `session-params.json` (route params set with `params set`; never committed) and `param-discovery.json` (ids link discovery found this watcher session)
- `decisions-cache.json` (route pruning decisions per file content, shared by the watcher and `finish`)
- `proof-block.md` (written by `finish` on every outcome)
- `scratch/index.jsonl` (one frame record per line, with `timing`) and `scratch/frames/<id>.png`

Headline stills are copied to the artifact dir as `<route-slug>-<shortTree>.png` (sidecar stills as
`sidecar-<scenario>-<still>-<shortTree>.png`), and the replay video as `replay-<shortTree>.mp4`.

## Model decisions (A4)

Fast typed-answer model calls at a few bounded decision points, never navigation. They need an OpenRouter key:
`OPENROUTER_API_KEY` in the environment, or in a `.env` file next to the config. **Without a key nothing changes:**
the DOM heuristics are all there is, and `doctor` says `heuristics-only`. Both models are served by OpenRouter's
Decisions API (`POST https://openrouter.ai/api/alpha/decisions`): questions of type `choice`, `noul` (probability
of yes) or `score` against one state, answered in parallel, with no free text. A request has an 8 s timeout and one
retry on 429/5xx (honoring `retry-after`); the key never appears in logs, notes or the proof block.

```json
{
  "decisions": {
    "enabled": true,
    "models": { "triage": "openai/gpt-6-luna-decisions-20261006", "text": "typesafe/jev-1.13" },
    "triage": "warn",
    "prune": { "above": 6, "keep": 4 },
    "verdict": true,
    "captions": true,
    "budgetMs": 10000
  },
  "claimFile": "docs/claim.md"
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | on when a key exists | `false` never makes a request (cached prune decisions still apply); `true` without a key adds a note to the proof block |
| `models.triage` | `openai/gpt-6-luna-decisions-20261006` | image model (pinned) for the image check |
| `models.text` | `typesafe/jev-1.13` | text model (resolves to a dated id such as `typesafe/jev-1.13-20260917`; the dated id is what answers) for pruning, claim and captions |
| `triage` | `warn` | `fail`, `warn` or `off`: what a non-clean image check does; `off` sends no image requests |
| `prune` | `{ above: 6, keep: 4 }` | prune when one changed file fans out to more than `above` routes, keeping the `keep` likeliest; `false` disables |
| `verdict` | `true` | advisory claim check against `claimFile` |
| `captions` | `true` | a caption under each headline still |
| `budgetMs` | `10000` | time all decisions of one `finish` share; unfinished work is skipped with a note |

**Image check.** Each headline frame the DOM heuristics call `clean` is shown to the image model as a `choice`
between `clean`, `loading`, `error` and `blank` (DOM says fine, the pixels may not). One request per frame, up to 6
at a time. A non-clean answer with confidence 0.7 or more fails `finish` with
`<route> looks <label> to the image check (<confidence>)` (`triage: "fail"`) or becomes a note (`"warn"`, the
default). The answer is recorded on the route in the proof block and in `--json` (`routes[].imageCheck`). An empty
state with an explicit message ("No invoices yet") counts as clean. If an image request reports more than 2000
input tokens, the image was read as text (a wrong-encoding regression): it is logged loudly in `watcher.log`, noted,
and the answer is ignored.

**Route pruning.** When one changed file fans out to more than `prune.above` routes, one text request asks, per
route, whether the change visibly affects it; the `prune.keep` likeliest and anything at 0.5 or more are kept. A
route whose page component or layout *is* the changed file is never asked about or pruned. The decision is cached
per (file, content hash, route set) in `decisions-cache.json` in the status dir, so the watcher captures, and
`finish` expects, the same routes; a cached decision applies even with decisions off. A failed or late request prunes
nothing. Pruned routes are listed in the notes.

**Claim check (advisory).** `finish` reads the claim (`claimFile`, default `<statusDir>/claim.md`; missing means a
note), splits it into criteria in code (bullet or numbered lines; otherwise the whole text is one criterion) and asks
one `noul` per criterion against the headline pages' visible text (up to 8 KB of the app root's text per frame, kept
in `frames/<id>.text.json` next to the PNG) and rendered component files. 0.7 or more is `satisfied`, below 0.3
`not visible`, else `partial`; the overall verdict is derived in code. It never fails `finish`. The model reads text,
so colors and layout are not visible to it. The proof block gets a "Claim check (advisory)" section ending with
`Advisory — reviewer decides.`

**Captions.** Three to five candidate captions are built in code (route title from the route file's `title`, else the
path; changed file names; style, template or script change from the diff); the text model picks one, shown under
the still. Without a key, or on failure, the first template is used.

**Accounting.** The proof block ends with `decisions: N requests, M ms, $cost` (M is wall time inside decision phases,
which run concurrently). One finish makes one image request per headline frame plus at most three text requests
(prune on a cache miss, claim, captions), about 1.2k input tokens and $0.00012 per image and about $0.00002 per
text request.

`doctor` has a `decisions` row: key present (and from where), the mode summary, and, with `doctor --probe-decisions`
or when the app answers, one tiny probe per model (bounded to 5 s) with the resolved model id and latency.
Tests and the known-bad corpus run with `decisions.enabled: false` so they stay offline and deterministic; the live
tests (`test/live`) run only when a key is available.

## License

MIT, see [LICENSE](LICENSE).
