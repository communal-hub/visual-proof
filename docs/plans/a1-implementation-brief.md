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
  hosts.ts          hostname globs and the block predicate behind blockHosts / allowHosts
  normalize.ts      doctor --json --normalize: strip ports, paths, hashes, timings, versions
  git.ts            tree hash, HEAD tree, changed files (and the range they came from), toplevel/branch/ancestor helpers
  anchor.ts         persistent diff anchor (anchors.json in the status dir)
  ready.ts          `status --wait` / `ready`: block until the watcher is ready
  rendered.ts       in-page Vue component-tree walker and `__file` normalisation (render check)
  decisions/        A4: OpenRouter Decisions client, image check, prune, claim verdict, captions, budget, sidecar (see "Decisions (v0.6)")
  sidecar.ts        sidecar scenario DSL: parser, file discovery, role/route validation (v0.7)
  replay.ts         replay video: ffmpeg probe, frame selection, captions, build (v0.7)
  trigger/
    vite-hmr.ts     freshness barrier: HMR websocket client
    fs-watch.ts     trigger: screen + backend globs
  resolve/
    import-graph.ts static import graph from route files -> file-to-routes map
    route-params.ts routeParams merged with the routeParamsFile seed file (re-read on every call)
    param-sources.ts third tier: paramSources list endpoints -> route params (pick grammar, per-session cache)
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
  "paramSources": {                             // third tier: fill a route's params from a list endpoint
    "/manage/invoices/:id": { "url": "/api/invoices", "pick": "data.0.id" },
    "/accounts/:id/:tab": { "url": "/api/accounts", "pick": { "id": "0.uuid", "tab": "'invoices'" } }
  },
  "sidecars": [".visual-proof/sidecars/*.vp"],  // sidecar scenario globs (relative to the config dir); this is the default
  "roles": { "finance": "finance@example.test" }, // role name -> login email for `login <role>`; `login default` is login.email
  "replay": { "enabled": true, "maxFrames": 60, "secondsPerFrame": 1.2, "maxHeight": 1600 }, // replay video built by finish when ffmpeg is on PATH
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
  "settle": { "networkIdleMs": 250, "maxWaitMs": 5000 }, // no request in flight for networkIdleMs, waiting at most maxWaitMs
  "fixedTime": "2026-01-15T09:00:00Z",          // freeze Date in every page; omit to leave time alone (default)
  "maskSelectors": [".clock", "text=Updated"],  // covered by a solid box in stills; default []
  "blockHosts": ["*.google-analytics.com"],     // aborted before navigation; default: the tracker list below; [] blocks nothing
  "allowHosts": ["browser.sentry.io"],          // exempt from blockHosts; default []
  "maxFrames": 200,
  "finishBudgetMs": 25000,
  "baseRef": "main",
  "decisions": { "enabled": true, "models": { "triage": "openai/gpt-6-luna-decisions-20261006", "text": "typesafe/jev-1.13" }, "triage": "warn", "prune": { "above": 6, "keep": 4 }, "verdict": true, "captions": true, "budgetMs": 10000 }, // A4, see "Decisions (v0.6)"
  "claimFile": "docs/claim.md"                  // default <statusDir>/claim.md
}
```

`routeParamsFile` points at a JSON file of either shape `{ "routes": { "<route key>": "<concrete path>" } }` or the flat `{ "<route key>": "<concrete path>" }`. Semantics:

- Entries from the file override `routeParams` for the same key; other keys merge.
- The file is re-read whenever params are needed (watch batches, `finish`, `doctor`); nothing is cached, so a file written after the daemon started is picked up without a restart. Backend-triggered re-captures re-resolve each captured route key against the current params.
- A missing file is empty, with no error. Invalid JSON or a wrong shape never crashes: `doctor` reports an error, `watcher.log` gets a one-line `warning: ...` (repeated only when the problem changes), and `finish` adds a note; all three fall back to config `routeParams`.
- Values must be strings starting with `/`; others are ignored with a warning (same three places).
- `doctor` gains a `params` capability, never required: tier `seed-file` (`N entries from <file>`) when the file is present, else `config` (`N entries`), else `none`. A missing file is a `warn` (`routeParamsFile not found: <path>`); an unreadable or invalid file is tier `invalid`.

### Route params from list endpoints (v0.4)

Third tier after `routeParams` and `routeParamsFile`, in `src/resolve/param-sources.ts`.

- **Config** (`paramSources`, validated at load): key = route key with at least one `:param`; `url` = app-relative path (starts with `/`, not `//`); `pick` = string (a route with exactly one param) or object `{ <param>: <pick> }` covering every param of the route and nothing else (an object is allowed for one param too). Anything else is a config error naming the key.
- **Pick grammar:** a quoted value (`'x'` or `"x"`, non-empty) is a literal. Otherwise a `.`-separated path whose segments are object keys (own properties only) or array indexes (digits); a segment on an array that is not an index, an index past the end, a missing key, or descending into a scalar is an error that names the path walked so far. The final value must be a non-empty string or a finite number, else `pick "<p>" is <what>, expected a string or number`. The value is `encodeURIComponent`'d into the route key's `:param` slots.
- **Fetch:** `Capturer.getJson(urlPath)` (optional) = `context.request.get(appUrl + urlPath)` on the watcher's own context: its cookies, `ignoreHTTPSErrors`, `Accept: application/json`, 15 s timeout, one re-login and retry on 401/403 when `login` is `http-hook`. It returns `{ status, json? , error? }`; `error` is `HTTP <status>`, `response is not JSON`, or the transport message (`status: 0`). A capturer without `getJson` cannot resolve sources (`this capturer cannot fetch JSON`).
- **When:** lazily, only for a route key that `routeParams` and the seed file do not fill: in a screen batch for skipped routes, in a recapture (backend, or an unmapped screen) for captured routes that no longer resolve through the earlier tiers, and for explicit `warmupRoutes` entries. Concurrent requests for a key share one fetch.
- **Cache:** successes are kept per session (`ParamSourceResolver`); a batch with backend files invalidates all of them before resolving (a fetch that started before the invalidation cannot repopulate the cache). Failures are never cached.
- **Failure:** the route is skipped (also on a recapture: the previously captured id is not reused). The reason is `paramSources <url> failed: <error>` (fetch) or `paramSources <url>: <why the pick failed>` (shape), logged once per distinct message as `warning: <reason> (route <key>)` and stored in `status.json` `paramSources[<key>] = { path?, error?, at }` (`path` = the last id that worked; success clears `error`).
- **finish:** a changed route key that the earlier tiers cannot fill but `paramSources` covers is expected by key (the frame's `route` supplies the concrete path in the result). No frame at HEAD and `status.json` has an `error` for the key: failure `cannot capture <key>: <error> (add routeParams)`; no frame and no error: the ordinary `no frame at HEAD for <key>`; a frame at HEAD wins over an error. A captured source route re-added by a backend change is likewise expected by key.
- **doctor:** capability `paramTiers` (after `params`; never required), tier `list-endpoint` when any source is configured, else `none`. Detail `N route(s) with params: config a, seed-file b, list-endpoint c, uncovered d` (routes with params from the import graph and `staticRoutes`; precedence seed-file, config, list-endpoint), then `uncovered: <keys>`, `paramSources for no known route: <keys>`, and for each source one `probe <url> -> <path>` or `probe <url> for <key> failed: <reason>`. Sources are probed in one bounded call (`timeouts.paramsMs`, default 4 s) through a Playwright `APIRequestContext` that logs in first; with the app down: `paramSources not probed: app not reachable at <appUrl> (<error>)`. Status `warn` for uncovered routes, stray keys, failed or skipped probes.
- `RouteParams.fileKeys` lists the route keys the seed file filled (doctor counts tiers with it).

### Flake controls (v0.4)

- **Fixed clock:** `fixedTime` must be an ISO 8601 date (`YYYY-MM-DD...`, parseable). At context creation, before any page navigates, `context.clock.setFixedTime(new Date(fixedTime))` (Playwright >= 1.45, so inside the 1.57 peer floor; still feature-detected: a context without `clock.setFixedTime` logs `fixedTime ignored: ...` once). `Date.now()`, `new Date()`, `Intl` and `performance` follow the clock; timers and animation frames keep running. Unset by default.
- **Masks:** `maskSelectors` become Playwright `mask` locators on the screenshot (default magenta box; the layout is untouched). A selector with no match is skipped; one whose `locator.count()` throws is logged once (`maskSelectors entry "<sel>" is not a valid selector (...); ignored`) and skipped. `CaptureLayout.masked` counts masked elements.
- **Blocking:** `context.route` on the whole context at creation: a request whose URL host is blocked is aborted (`net::ERR_FAILED`). Host globs (`src/hosts.ts`): case-insensitive, `*` = any characters including dots, a leading `*.` also matches the bare domain; entries must not contain a scheme, port, path or whitespace. A host is blocked when it matches `blockHosts`, does not match `allowHosts`, and is not the host of `appUrl` or `viteUrl`; only http(s)/ws(s) URLs are considered. Default `blockHosts` (replaced, not extended, by a configured list; `[]` disables): `*.google-analytics.com`, `*.googletagmanager.com`, `*.posthog.com`, `*.segment.io`, `*.hotjar.com`, `*.intercom.io`, `*.sentry.io`. A console error `net::ERR_FAILED` / `net::ERR_BLOCKED_BY_CLIENT` whose resource URL is a blocked host is dropped from `consoleErrors` (triage never sees it); a page error thrown by app code reacting to the missing script is not filtered.

### Settle and timing (v0.4)

- `settle.networkIdleMs` (default 250, was a fixed 500 from Playwright's `networkidle`) and `settle.maxWaitMs` (default 5000, positive integers). The browser tracks in-flight requests per page from before navigation (`request` / `requestfinished` / `requestfailed`) and settles when none was in flight for `networkIdleMs`, or after `maxWaitMs`. The same window, capped at 1.5 s, is used after the page grew for a full-page still.
- Default choice (fixture, warm, 5 samples each, `test/integration/settle-bench.test.ts`): median save-to-still 955 ms at 500, 708 ms at 250, 598 ms at 150; zero non-clean captures at any of them in the save-to-still runs and in 54 sweep captures each (every fixture route, alone and four at a time). 250 became the default after three full test runs with no non-clean frame; 150 was not adopted (largest saving, thinnest margin for apps with request gaps). Apps whose requests chain with gaps above the window should raise it.
- `CaptureResult.timing` / frame record `timing: { settleMs, screenshotMs }`: `settleMs` = from `load` to a settled, read page (network idle, fonts, two frames, DOM read, including any re-settle after the page navigated itself); `screenshotMs` = from the settled page to the PNG (rendered-component walk, page preparation, masks, the screenshot). Absent on frames from earlier versions and from capturers that do not report it.

### Decisions (v0.6, A4)

Model calls at bounded decision points through OpenRouter's Decisions API, in `src/decisions/**`. Never navigation; no free text.

- **API (spike, live):** `POST https://openrouter.ai/api/alpha/decisions`, `Authorization: Bearer <key>`, body `{ model, state, questions: { <id>: { type, instructions, criteria } } }` -> `{ model, answers: { <id>: ... }, usage: { input_tokens, output_tokens, cost } }`. `criteria` is validated per type before the model is looked up: `choice` = record choice -> description (required); `score` = array of anchors (required); `noul` = optional `{ true, false }` record. A `noul` answer is `{ noul: p }`, p = probability of yes; a `choice` answer has `choice`, `probabilities`, `confidence`. Unknown model: 400 `Model <id> does not exist`. Model ids: `typesafe/jev-1.13` resolves to the dated `typesafe/jev-1.13-20260917` (the response `model`; bare `typesafe/jev` and `typesafe/jev-router` do not exist); `openai/gpt-6-luna-decisions-20261006` is the pinned image model (`openai/gpt-6-luna-decisions` resolves to it). Neither appears in `/api/v1/models`. Images: `state: [{ type: "image_url", image_url: { url: "data:image/png;base64,..." } }]`, about 1.2k input tokens (1,174 to 1,254) and $0.00012 per 1280x800 still, 250 to 500 ms warm; any other encoding is read as text.
- **Multi-image (spike):** with four images in one request and one question per image ("look only at image N"), Luna answered every image correctly in both orders, but confidence dropped from 1.0 (single image) to 0.53 to 0.99, so a right error answer could fall below the 0.7 threshold. Design: one image per request, concurrently (cap 6).
- **Client** (`client.ts`): key from `OPENROUTER_API_KEY` or `OPENROUTER_API_KEY=` in `<configDir>/.env`; 8 s timeout per attempt; one retry on 429/5xx with `retry-after` (seconds or date, capped at 3 s) else 400 to 700 ms; an `AbortSignal` cancels a request and its back-off; typed results `{ ok: true, answers, model, requestedModel, usage, ms } | { ok: false, kind: no-key|timeout|aborted|http|network|invalid, error, status?, ms }`; `stats` accumulates `requests` (a retry is not a request), `retries`, `failed`, `ms`, `cost`, `inputTokens`. Error text never contains the key.
- **Config:** `decisions` (all optional): `enabled` (default: on when a key exists; `false` never makes a request; `true` without a key adds the note `decisions are enabled but OPENROUTER_API_KEY is not set ...`), `models.triage` / `models.text`, `triage` `fail|warn|off` (default `warn`), `prune` `{ above: 6, keep: 4 }` or `false`, `verdict` (true), `captions` (true), `budgetMs` (10000). Unknown keys are errors. `claimFile` (relative to the config dir; default `<statusDir>/claim.md`).
- **Image check** (`image-check.ts`): for each clean headline frame, one `choice` `frame` over `clean|loading|error|blank` (criteria in code). Non-clean with `confidence` (else the chosen probability) >= 0.7: `triage: fail` -> failure `<route> looks <label> to the image check (<confidence, 2 decimals>)`; `warn` -> the same text as a note. Request failure, budget, unknown label or `usage.input_tokens > 2000` (wrong encoding; logged `decisions: ERROR ...` in `watcher.log`) -> `unknown`, noted as `image check unknown for <routes>: <why>`, never a failure. `RouteProof.imageCheck = { label, confidence, action: none|fail|warn, model?, ms, note? }`; the status line gains ` · image check: <label> (<confidence>)`.
- **Pruning** (`prune.ts`, hooks `pruneForWatch` in `watch.ts` `resolveScreen` and `pruneForFinish` in `finish.ts` before the expected set is built): per changed screen file whose route-key fan-out (graph + `staticRoutes`, including param-skipped keys) exceeds `prune.above`: state `{ file, diff (trimmed to 6000 chars; the file content when git has no diff), routes: [{ key, components: [layouts..., page, file] }] }`, one `noul` per route ("Does this change visibly affect what <key> renders?"), kept = routes the file is directly (page component or layout) + top `keep` by probability (ties by route key) + any >= 0.5. A route is dropped only when every changed file that reaches it dropped it. Decisions are cached in `<statusDir>/decisions-cache.json` keyed by (file, sha1 of the working-tree content), valid only for the same sorted route-key list; read by both the watcher and `finish`, and honored when decisions are off. A failed, partial, late or no-client decision prunes nothing and is not cached. Watch bounds the request to min(`budgetMs`, 5 s). Notes: `pruned N of M route(s) for <file>: <key> <p>, ... (kept ...); decision by <model>[ (cached)]`.
- **Claim verdict** (`claim.ts`): criteria = bullet (`-*+`) or numbered (`1.` `1)`) lines (max 12, 300 chars each), else the whole text as one. State `{ claim: [criteria], pages: [{ route, visibleText, renderedFiles }] }` (page text trimmed so all pages together stay under about 24k chars); one `noul` per criterion: >= 0.7 `satisfied`, < 0.3 `not visible`, else `partial`; overall in code: all satisfied -> `satisfied`, all not visible -> `not visible`, else `partial` (an unanswered criterion counts as partial). Advice only: `FinishResult.claim = { source, criteria: [{ text, probability, result }], verdict, routes, role, model?, note? }`; role = `login.email` or `anonymous`. Proof block section `**Claim check (advisory)**` ending with `Advisory — reviewer decides.` Missing claim file: note `claim check skipped: no claim at <path> ...`.
- **Page text sidecar:** capture keeps up to 8192 characters of the app root's whitespace-collapsed `innerText` (`CaptureResult.pageText`; `signals.text` stays at 2048) and the watcher writes `scratch/frames/<id>.text.json` = `{ version: 1, text }` next to the PNG (only when `decisions.verdict` and `enabled !== false`); never in `index.jsonl`. Orphans (PNG evicted) are swept on each write.
- **Captions** (`captions.ts`): 3 to 5 candidates in code per headline (route title from the route file's `title`/`meta.title` after its `path:` literal, else the path; changed file basenames; change kind from the diff: `.vue` sections `style|template|script`, else by extension `style|template|script|data|content`); one batched `choice` request over all frames; the first template is the fallback. Shown as an italic line between the still and its status line (`RouteProof.caption`).
- **Budget and accounting** (`runtime.ts`, `budget.ts`): `budgetMs` is shared by every decision phase of a finish (prune before the daemon wait, then image + claim + captions together, concurrently); the clock only runs inside phases and never past finish's own deadline - 250 ms; work unfinished at the deadline is cancelled and noted (`decisions: unfinished work was skipped at the <n> ms budget`). `FinishResult.decisions = { requests, ms, cost, inputTokens, failed }` and the proof block ends with `decisions: N requests, M ms, $cost` (only when decisions were active). Target: one image request per headline plus at most 3 text requests (prune on a cache miss, claim, captions).
- **doctor:** capability `decisions` (never required; after `renderCheck`): tier `off` (`enabled: false`), `heuristics-only` (no key; status `warn`), `key-present` (not probed), `openrouter` (both models probed ok), `degraded` (a probe failed or timed out; `warn`). Models are probed (one tiny request each, 5 s total) only with `doctor --probe-decisions` or when `appUrl` answers HTTP (1.5 s check); detail names the key source, each model as `<id> -> <resolved id> ok (<ms> ms)` and the mode summary.
- **Tests:** the suite strips `OPENROUTER_API_KEY` (`test/setup.ts`); the integration harness writes `decisions: { enabled: false }`; `test/live/**` is gated on a key (`VP_LIVE_OPENROUTER_API_KEY` or the worktree `.env`).
### Sidecar scenarios (v0.7)

`src/sidecar.ts`. One `.vp` file is one scenario, named by its filename without the extension (`refund.vp` -> `refund`). A file is found when its config-relative POSIX path matches a `sidecars` glob (`findSidecarFiles` walks from each glob's literal base; `node_modules` and `.git` are skipped; a base that does not exist matches nothing).

- **Config** (validated at load): `sidecars` = array of strings (default `[".visual-proof/sidecars/*.vp"]`; `[]` disables); `roles` = object of role name to non-empty email (names `[A-Za-z0-9._-]+`; `default` is reserved: it is `login.email`); `replay` = `{ enabled: boolean, maxFrames: positive int, secondsPerFrame: positive number, maxHeight: positive int }`.
- **Grammar**, one step per line. Lines are trimmed; blank lines and lines starting with `#` are skipped (no trailing comments: `click #submit` is a selector). CRLF and a BOM are accepted. The verb is the first word, lowercase, and must be one of:
  - `goto <target>`: one token starting with `/` (not `//`); a route key (`/a/:id`) or a concrete path with optional query.
  - `click <selector>`: the rest of the line, raw.
  - `fill <selector> <text...>`: selector = first word, or a `"..."` / `'...'` string; text = the rest of the line raw, or exactly one quoted string (`""` = empty); escapes inside quotes `\\ \" \' \n \t`, any other `\x` is kept as written; anything after the closing quote is an error; missing text is an error.
  - `press <key>`: one token (a Playwright key such as `Enter`, `Control+A`).
  - `wait <selector | ms>`: `^\d+(ms)?$` is a delay (1 to 30000), anything else is a selector (rest of the line).
  - `still <name>`: `[A-Za-z0-9][A-Za-z0-9._-]*`, unique in the file.
  - `login <role>`: one token matching the role-name pattern.
  Parse errors never throw: `Sidecar.errors` is `[{ line, message }]` (line 0 = the file as a whole: no steps, no `still`). Messages: `unknown verb "x" (the verbs are goto, click, fill, press, wait, still, login)`, `<verb> needs ...`, `duplicate still name "x" (first used on line N)`, `missing closing " quote`, and so on. `validateSidecar(sidecar, config)` adds what needs the config: `unknown role "x" (known: default, finance; add it to "roles")` and `login needs a login hook: set login.type to "http-hook"`. A formatted error is `<file>:<line>: <message>` (`<file>: <message>` for line 0).
- **Routes.** A still's frame has `route` = `routeKey` = `sidecar:<file>#<still>` (`<file>` = config-relative path). `sidecarRoute`, `isSidecarRoute`, `parseSidecarRoute` build and read it. The synthetic frame of a failure after the last `still` uses the still name `!failed` (cannot collide with a real name).
- **Route keys of a scenario** (`scenarioRouteKeys`): for each `goto`, the target itself when it is a known route key, else the known route patterns (`:param` = `[^/]+`) that match its pathname (query and hash ignored), a route without params winning over parametrised ones; a target that matches nothing stands for its pathname.

**Execution** (`Browser.runScenario(plan)`, `Capturer.runScenario?`). The watcher resolves each `goto` to a concrete URL before handing the plan over (`ScenarioPlan.gotos`: line -> `{ url, path }` or `{ error }`): a concrete path as is; a route key through `concretePath` over `routeParams` + seed file, then `paramSources` (the same tiers and cache as route captures; failing that, `cannot fill <key>: <reason>`, shown to the user as `<reason> (add routeParams)`).

- One fresh page in the shared context, opened with the same listeners as a capture. After each `goto` the page settles (network idle, fonts, two frames, DOM read, re-settle on a self-navigation); after `click` / `fill` / `press` a short settle (network idle capped at 2 s, two frames).
- `still`: settle, read the DOM, then the capture's screenshot half (`shoot`: renderedFiles walk, `preparePage`, masks, PNG) and then `UNPREPARE_SCRIPT` (removes the `style[data-visual-proof]` elements and the `data-vp-grow` / `data-vp-flow` attributes) so the scenario continues from the same page. Signals: `navOk` true, `httpStatus` of the last document load, console and page errors since the previous still (the list is cleared after each), `authFailure` when a `goto` landed on a login page after one re-login.
- Selectors are found with `locator(sel).first()` waiting for `visible` up to `stepTimeoutMs` (5000): a timeout is `selector not found` (nothing matches) or `selector not visible`; any other Playwright error is `invalid selector: <first line>`. `click` / `fill` errors are `click failed: ...` / `fill failed: ...`, `press` is `press failed: ...`, a `goto` that throws is `navigation failed: ...`. A 504 `Outdated Optimize Dep` after a `goto` loads the page again (2 retries). `wait <ms>` sleeps.
- `login <role>`: `context.clearCookies()`, then the login hook POST as the role's email (`sessionEmail` is tracked; `ensureLoggedIn` only trusts a session whose email is `login.email`). After the scenario (always) the default login is restored; a failed restore leaves the session marked logged out so the next capture logs in again.
- **Limits.** Every wait and navigation is capped by what is left of `scenarioTimeoutMs` (60000); a hard race at that limit plus 1 s closes the run (`scenario exceeded 60 s`). Both are `BrowserOptions` (tests shorten them).
- **Failure.** The first failing step ends the run: `failure = { line, text, reason }` and an extra still whose frame is an error: the name of the first `still` at or after the failing line (it may be the failing step itself), else `!failed`; the signals carry `stepFailure = "line <n> <step text>: <reason>"` (`triage` puts it first in `reasons`, status `error`); the screenshot is the page as left (best effort, 8 s guard, a blank PNG when the page is gone). Stills before the failure are normal frames; later stills get no frame.
- **Result:** `ScenarioResult = { stills: ScenarioStill[], failure?, ms }`; a `ScenarioStill` has `name`, `at`, `png`, `signals`, `renderedFiles`, `timing`, `steps` (`{ line, text }` from the start up to and including the still or the failing step) and `failed`.

**Frames.** `Frame.trigger` gains `sidecar` (the scenario's file changed; otherwise `screen` or `backend` for the cause of a replay); `Frame.steps?: { line, text }[]` (sidecar frames only); `sourceFile` is the sidecar file. Sidecar stills also write the decisions page-text file (`frames/<id>.text.json`, the same one route frames get when `decisions.verdict` is on; unrelated to `.vp` sidecar files, which live in the repo) and appear in the decisions headlines with `via: 'sidecar'`. Sidecar frames never enter the watcher's `sessionRoutes` (route recapture) and `finish` ignores them when listing captured routes for a backend change.

**Trigger.** `startFsWatch` takes `sidecarGlobs` and reports a third list, `WatchBatch.sidecar` (optional in the type). A sidecar file is neither a screen nor a backend file even when it matches those globs (`classifier(...).isSidecar`). A sidecar-only batch does not wait for the HMR barrier. `BatchEvent` gains `sidecar` and its `routes` include sidecar routes.

**When the watcher replays** (`pickScenarios`, after the batch's route targets are known, in the same queue and under the same before/after tree-hash check, so a batch discarded for a tree change drops scenario frames too and is re-queued with its `sidecar` list):
1. every changed sidecar file that still exists;
2. every scenario whose `goto` route keys intersect the routes of the batch's screen files (`graph.fileToRoutes` then `staticRoutes`);
3. when the batch re-captures routes (a backend change, or a screen file with no route), every scenario that produced frames earlier this session.
A deleted file is forgotten. A scenario that does not parse or validate is skipped: one `warning: sidecar <file>:<line>: <message>` log line per distinct problem set and `sidecar <file> skipped: N parse error(s)`; it records no frame, and `finish` reports it. A capturer without `runScenario` logs `sidecar <file> skipped: this capturer cannot run scenarios`.

**finish.** After the route expectations, for each file at HEAD (`git ls-tree`, read with `git show HEAD:./<file>`) that matches `sidecars`: expected when it is in the changed set, or one of its route keys is in the expected route set (screen routes, `paramSources` keys, and routes added by a backend change). A changed set made only of sidecar files is not "no screen changes"; one whose sidecars are all deleted is. A scenario that does not parse or validate adds `sidecar <file>:<line>: <message>` failures. Each `still` becomes a `RouteProof` (`via: 'sidecar'`, `scenario: { file, name, still }`, `route` = `routeKey` = `sidecar:<file>#<still>`), appended after the route proofs, so `waitForDaemon` waits for them too. Failures:
- no frame at HEAD's tree: `sidecar <file> still <name>: no frame at HEAD` (plus the hint to replay it);
- not clean: `sidecar <file> still <name>: final frame is <status>: <reasons joined by "; ">`;
- a `!failed` frame at HEAD's tree newer (by frame id) than every still frame of that scenario at HEAD: `sidecar <file>: final frame is <status>: <reasons>`.
Headline PNGs are copied as `sidecar-<scenario>-<still>-<shortTree>.png`. The render check also accepts a clean sidecar still whose `renderedFiles` contain the changed `.vue` file (note `<file> rendered in sidecar <file> still <name>`; a route frame that rendered it needs no note). The proof block labels them `sidecar <scenario> / <still>` and adds ` · <sidecar file>` after the tree; `FinishResult.routes` carries them.

### Replay video (v0.7)

`src/replay.ts`, called by `finish` after the render check, only when there are expected routes or stills, no failures, the finish is not truncated and `replay.enabled`. Never a failure: every problem is a note.

- **ffmpeg probe** (`probeFfmpeg(env)`, cached per `env.PATH`): `ffmpeg -version` (ENOENT -> `ffmpeg not found`), `-encoders` (needs `libx264`), `-filters` (`drawtext`), then a one-frame `drawtext` run (default font, then common font files) to prove captions work. `finish` runs ffmpeg through `FinishOptions.env` (PATH), so tests can hide it.
- **Frames:** `timeline.list({ sessionId })` of the daemon session (all frames when there is no session id), those with a PNG on disk, the latest `replay.maxFrames`, oldest first.
- **Canvas:** width = viewport width, height = the tallest selected frame (at least the viewport height) capped at `replay.maxHeight`, both rounded down to even; a 36 px caption bar is added below when captions are on. Frames are scaled to fit (`force_original_aspect_ratio=decrease`) and padded top-aligned on `0x202020`.
- **Encode:** a numbered image sequence in a throwaway directory under the scratch dir (`-framerate 1/<secondsPerFrame>`; the concat demuxer was rejected: it drops or stretches the last entry depending on frame sizes), `-vf <chain>` inline (`-filter_script` is gone from recent ffmpeg), no `fps` filter (a frame-size change re-initialises the graph and drops the frame it holds), `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -r 10 -t <frames * secondsPerFrame> -movflags +faststart`. Output `replay-<shortTree>.mp4` in the artifact dir (written in the work dir, then copied). ffmpeg 6 ends one output frame (0.1 s) early, 9 does not.
- **Captions:** one `drawtext` per frame from a text file (`expansion=none`), enabled for `gte(t, (i-0.5)*d) * lt(t, (i+0.5)*d)`. Text: `<route or "sidecar <scenario> / <still>"> [<status> if not clean]   |   <source file>   |   HH:MM:SS` (UTC), non-ASCII replaced by `?`. Without drawtext or a font: no bar, note `replay built without captions: <reason>`.
- **Budget:** skipped with a note when `remaining < 600 + 40 * frames` ms; otherwise ffmpeg gets `remaining - 250` ms and is killed (SIGKILL, without waiting for its pipes) on overrun: `replay skipped: ffmpeg did not finish within the <n> ms of finish budget left`.
- **Notes:** `replay skipped: ffmpeg not found`, `replay skipped: this ffmpeg has no libx264 encoder`, `replay skipped: no frames with a screenshot in this session`, `replay skipped: <n> ms of the finish budget left, about <m> ms needed for <k> frame(s)`, `replay failed: <ffmpeg's last stderr line>`.
- **Result:** `FinishResult.replay?: { path, frames, seconds, captions, ms }`; the proof block has `[Replay](<absolute path, spaces and parentheses percent-encoded>) · <frames> frame(s), <seconds> s` after the stills.
- **doctor:** `sidecars` (tier `none` | `files` | `invalid`; `N scenario(s) found, M still(s), 0 parse errors`, or the first five `<file>:<line>: <message>`; `invalid` is status `missing`, never required) and `replay` (tier `ffmpeg` | `no-captions` | `no-x264` | `none` | `off`; detail `ffmpeg <version>, drawtext available`; warn when anything is missing; never required) after `renderCheck`. `Probes.ffmpeg(env)` is the new probe. `normalize` also replaces `ffmpeg <version>`.

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
- `status.json`: `{ state: "starting"|"ready"|"capturing"|"error"|"stopped", sessionId, pid, startedAt, trigger: "fs-watch", barrier: "vite-hmr"|"timeout-only", anchor, lastCaptureAt, lastEventAt, pending, pendingSince, lastError, frames, warmup }`. `pid` is the watcher process; `anchor` is the diff anchor (see `anchors.json`; null outside a repo or with no commits); `paramSources` (absent until a `paramSources` route is looked up) maps route key to `{ path?, error?, at }`; `warmup` is absent until the warm-up step and then `{ state: "running"|"done"|"failed"|"timeout"|"skipped", ms?, routes: [{ route, ms, ok, reloads?, error? }] }`. `state` stays `starting` until the warm-up is over. `pending` is true from the first relevant file event of a change (before the debounce ends) until its batch, including re-queues, is fully handled; `pendingSince` and `lastEventAt` are ISO timestamps (or null). `lastError` is the latest unresolved problem (a refused capture, a failed capture) and is cleared by the next fully captured batch. `finish` adds `lastFinish: { at, ok, failures, proofBlockPath, summary }` to the same file on every outcome. `status` reports a stored `starting`/`ready`/`capturing` whose watcher process is gone as `state: "stopped"`, `stale: true`, `lastError: "watcher exited without stopping"`.
- `anchors.json`: `{ "<git toplevel>\n<branch>": { anchor, at } }`. At start the watcher looks up the key (`(detached)` for a detached HEAD): a stored anchor is reused (the earliest anchor of the branch survives daemon restarts) while it is an ancestor of HEAD and less than 24 h old (so a leftover from an earlier task on the same branch name cannot widen today's diff); otherwise HEAD is stored and used. Outside a repo or without commits nothing is persisted. The log says `anchor <sha8> (HEAD|reused from an earlier session of this branch|HEAD, not persisted)`.
- `watcher.log`: one line per event, ISO timestamp first.
- `doctor.json`: resolved tier per capability.
- `proof-block.md`: written by `finish` on every outcome (a failure block when finish could not run: bad config, not a git repo, internal error), atomically (tmp + rename).
- `decisions-cache.json`: route pruning decisions (A4), shared by the watcher and `finish`.
- `scratch/index.jsonl` + `scratch/frames/<id>.png` (+ `<id>.text.json` page text sidecar, A4).

The artifact dir holds the headline stills, the sidecar stills (`sidecar-<scenario>-<still>-<shortTree>.png`) and `replay-<shortTree>.mp4`.

## Frame record (one JSON line in index.jsonl)

```json
{ "id": "f-000042", "sessionId": "s-...", "route": "/invoices/1", "routeKey": "/invoices/:id",
  "at": "2026-10-08T12:00:00.000Z", "treeHash": "<40 hex>", "trigger": "screen|backend",
  "sourceFile": "src/pages/Invoice.vue", "status": "clean|loading|error|blank",
  "reasons": ["console error: ..."], "renderedFiles": ["src/App.vue", "src/pages/Invoice.vue"],
  "timing": { "settleMs": 362, "screenshotMs": 44 },
  "png": "frames/f-000042.png" }
```

A sidecar still (v0.7):

```json
{ "id": "f-000043", "route": "sidecar:.visual-proof/sidecars/refund.vp#refund-modal",
  "routeKey": "sidecar:.visual-proof/sidecars/refund.vp#refund-modal", "trigger": "sidecar|screen|backend",
  "sourceFile": ".visual-proof/sidecars/refund.vp", "status": "clean",
  "steps": [{ "line": 2, "text": "goto /manage/invoices/:id" }, { "line": 3, "text": "click [data-test=invoice-refund]" }, { "line": 5, "text": "still refund-modal" }], ... }
```

`steps`: sidecar frames only; the steps run from the start of the scenario up to and including the `still` (an error frame: up to and including the failing step).

`renderedFiles`: repo-relative component files mounted in the page (see Rendered components; at most 2000), or `null` when unknown (production build, non-Vue app, `renderCheck: "off"`); absent on frames written by versions before 0.3.

`timing`: where the capture spent its time in ms (see Settle and timing); absent on frames written before 0.4 and from capturers that do not report it.

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

Capture waits: `load`, then network idle (`settle.networkIdleMs`, default 250 ms, capped at `settle.maxWaitMs`, default 5 s), `document.fonts.ready`, two `requestAnimationFrame`s. Reduced motion on. The clock is only frozen when `fixedTime` is set. Requests to blocked hosts are aborted and their failed-resource console line is not an error (see Flake controls).

## finish semantics

1. Changed files = the committed diff plus uncommitted changes, with paths relative to the config directory (git reports toplevel-relative paths; `git rev-parse --show-prefix` is stripped and anything outside the config directory dropped). The committed diff is the first of these that yields files: `<baseRef>...HEAD` (or `origin/<baseRef>...HEAD`), then `<anchor>..HEAD` (the `anchor` in `status.json`), then `HEAD~1..HEAD`. An empty `<baseRef>...HEAD` is not trusted: working directly on the base branch makes it empty even after commits. The range used is printed in the proof block notes (`diffed <range>`). If no changed file matches `screenGlobs` or `backendGlobs`, write an empty proof block (an HTML comment naming the range), print `no screen changes`, exit 0.
2. Expected routes = routes resolved from the changed screen files (a file matching `ignoreScreenGlobs` is not a screen), plus every route captured by the current daemon session (the `sessionId` in `status.json`; all frames when there is none) when a backend file changed. Anything that cannot be turned into a capturable route is a failure, not a note:
   - a changed screen file with no route → `no route for <file> (not reachable from routeFiles; add staticRoutes or ignoreScreenGlobs)`
   - a route with unfilled params → `cannot capture <routeKey>: <reason> (add routeParams)`
   - a backend change with no captured route → `backend change (<files>) has no captured route to prove; open a page so the watcher captures it, or add staticRoutes`
3. Wait for the daemon. `finish` often runs right after the last save and commit. While a live daemon (pid alive, state not `stopped`/`error`) is `capturing`, has `pending` set, or a change newer than its `lastEventAt` is on disk (changed-file mtime under 2 s) and the working-tree hash differs from the newest frame's tree, poll every 200 ms until every expected route has a frame at `HEAD^{tree}` or the daemon is idle, bounded by the remaining `finishBudgetMs`. If the budget runs out first: failure `capture still in progress after <n> s`. No daemon, or an idle one, means the timeline is final.
4. For each expected route: the headline is the latest frame with `treeHash == HEAD^{tree}`.
   - No such frame → the route's **latest frame at any tree** may be carried forward (below); otherwise failure `no frame at HEAD for <route>`, followed by ` (<why>)` when an earlier clean frame existed but could not be carried (`the last clean frame, at tree <short>, is stale: <file> changed since`, or `... which git cannot compare with HEAD`, or `... but there is no import graph to tell what changed since`). A sidecar still fails as `sidecar <file> still <name>: no frame at HEAD[ (<why>)]`.
   - Headline status not `clean` → failure `<route> final frame is <status>`. Never fall back to an earlier clean frame behind a newer non-clean one: the frame considered for carrying is the latest one, and only a `clean` one is carried.
   - Render check (config `renderCheck`, default `fail`; `off` skips it). For each changed `.vue` screen file that resolved to routes (via `screen`; not routes added by a backend change), consider its routes that have a `clean` headline frame (routes without one already carry a failure). If any of those frames' `renderedFiles` contains the file, it passed (a note `<file> rendered on <A> but not on <B>` when only some did; a parent or layout in the mounted tree counts as rendered). Else if some of those frames have no data (`renderedFiles` null or absent) it is skipped with a note `render check skipped for <file>: ...`. Else failure `<file> never rendered on <routes>; seed the state that shows it (RecordsVisualProofRoutes) or add it to ignoreScreenGlobs`; with `renderCheck: "warn"` the same text is a note. Only `.vue` files are checked (the only files that carry `__file`).
   - **Carrying a frame forward** (`src/carry.ts`; v0.7). The watcher only re-captures what a save affects, so after two edits in a row an earlier route's frame is at an older tree. Such a frame (the latest for the route, `clean`, at tree T) stands at HEAD when none of the files that differ between T and `HEAD^{tree}` (`git diff --name-only T HEAD^{tree}`, config-relative, renames not followed) invalidates it. A changed file invalidates it when it: is a sidecar file and is the one the frame came from; is in the frame's `renderedFiles`; matches `backendGlobs`; matches `routeFiles`; is a screen file (matches `screenGlobs`, not `ignoreScreenGlobs`) that no route renders (not in `fileToRoutes` or `staticRoutes`); or is a screen file whose routes include one the frame depends on (a page route: its own key; a sidecar still: the routes its `goto` steps visit, `scenarioRouteKeys`). Other sidecar files and files outside `screenGlobs`, `backendGlobs` and `sidecars` (docs, tests, config) never do. Conservative: no import graph (`could not build the route graph`), a T that is not a tree git can compare (`treeDiff` returns null), or a non-clean frame mean no carry. A carried route has `RouteProof.carriedFrom` = T (the full hash) and the note `<route> carried forward from tree <short>: nothing it depends on changed since`; its `frameId` is the old frame's, the artifact is copied as usual, the proof block is otherwise unchanged. `waitForDaemon` still waits only for frames at HEAD's tree while the daemon is busy.
5. Copy headlines to the artifact dir as `<slug>-<shortTree>.png`. Write `proof-block.md` with one `<img>` per route, plus the route, status, and tree hash. Sidecar stills follow the route stills and the replay link follows them (see Sidecar scenarios and Replay video).
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
| `doctor` | table (one row per capability, including `paramTiers`, `renderCheck`, `decisions`, `sidecars` and `replay`; `--probe-decisions` probes the models) ending `details: <doctor.json path>` (`--json`: the report; `--json --normalize`: the report with timestamp, dirs, ports, hashes, timings and versions replaced, see below) | 0; 1 when the browser or the trigger is missing; 4 internal |
| usage error | | 2 |

### `doctor --json --normalize`

`normalizeDoctorReport` / `normalizeText` in `src/normalize.ts` (the same code the golden-file test uses). `at` becomes `<timestamp>`. Directories (repo = config dir, status, scratch and artifact dirs, the cwd, the OS temp dir, the home dir; each also by realpath, longest first) become `<repo>`, `<status-dir>`, `<scratch-dir>`, `<artifact-dir>`, `<cwd>`, `<tmp>`, `<home>`. A host (`localhost`, an IPv4 address, a dotted name) followed by `:<2-5 digits>` keeps the host and becomes `:<port>`. `[0-9a-f]{7,40}` becomes `<hash>`. `<digits> ms` becomes `<n> ms`. `Chromium|Chrome|Firefox|WebKit|Playwright|Vite|Node|visual-proof <version>` becomes `<name> <version>`. Route paths such as `/__playwright__/login` are left alone. `--normalize` is only valid with `doctor --json` (usage error otherwise) and only changes what is printed; `doctor.json` keeps the real values. The golden `test/golden/doctor-fixture.json` is exactly the normalized output for the fixture.

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
| sidecar-broken-step | Add a sidecar whose `click` selector matches nothing, let the watcher replay it, commit | `sidecar <file> still <name>: final frame is error: line 3 click [data-test=...]: selector not found` |

Plus one happy path: edit → clean frame → commit → `finish` exits 0 with a valid proof block.

## Fixture app (fixtures/vite-vue)

- Vite + Vue 3 + vue-router 4. `src/router/index.js` statically imports page components and maps them to paths, including one param route (`/invoices/:id`).
- A shared component used by two pages (for fan-out).
- `/long`: `src/pages/Long.vue` in `src/layouts/ScrollLayout.vue`, whose `html, body` never scroll while `main.content` (flex child, `overflow-y: auto`) holds 60 rows plus a solid green bottom marker, under a sticky header. `/flagged`: `src/pages/Flagged.vue` mounts `src/components/FlaggedDetails.vue` only when `GET /api/flags` (from `server/data.json` `flags.showDetails`, off by default) says so.
- `index.html` carries a stand-in for the devtools overlay (`#__vue-devtools-container__` holding a magenta `.vue-devtools__anchor` pill fixed at bottom-centre), so tests can check it is hidden.
- `visual-proof.param-sources.config.json`: the fixture config without `routeParams` and with `paramSources: { "/manage/invoices/:id": { "url": "/api/invoices", "pick": "0.id" } }`; the integration harness starts from it with `createHarness({ configFile })`.
- `/manage/interact` (`src/pages/Interact.vue`): a button (`[data-test=open-modal]`) that opens `src/components/ConfirmModal.vue` (`[data-test=confirm-modal]`), the two-step `src/components/TwoStepForm.vue` (`name-input`, `next`, `submit`, `done`) and `[data-test=finance-only]`, shown only to `finance@example.test`. The login hook accepts `admin@example.test` (the config default) and `finance@example.test` and rejects other emails with 403; `GET /api/me` returns `{ email, role }`. `.gitignore` is `.visual-proof/*` plus `!.visual-proof/sidecars/`; the integration harness writes scenarios with `writeSidecar(name, text)`.
- `VP_FIXTURE_CACHE_DIR` makes the fixture's Vite use its own dependency cache (cold-start tests).
- `#app` root. A `.spinner` element shown while data loads.
- Dev-only Vite middleware (in the fixture's own `vite.config.js`) that serves:
  - `GET /api/invoices` and `GET /api/invoices/:id` from `server/data.json` (the "backend"; re-read on every request).
  - `POST /__playwright__/login` that requires the `X-Visual-Proof-Token` header to match `.visual-proof/token`, then sets a session cookie. Pages under `/manage/*` redirect to `/login` without that cookie.
- The fixture writes its own `public/hot`-style marker on server start (`.visual-proof/hot`) so the freshness check is testable.
- A `visual-proof.config.json` for the fixture.
