# visual-proof

Visual proof for agent-made UI changes. A background watcher keeps a headless Chromium
warm, re-captures the affected screens of a Vite dev app every time you save, and
`finish` turns the result into a proof block (headline stills plus a markdown summary)
for HEAD. It fails loudly when a changed screen has no clean frame at HEAD.

Status: A1 (capture core). Vite apps only; Chromium only.

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
| `screenGlobs` | `src/**/*.vue` | files whose changes trigger a capture |
| `ignoreScreenGlobs` | `[]` | files that match `screenGlobs` but are not screens |
| `backendGlobs` | `[]` | backend files; a change re-captures routes already captured this session |
| `login` | `{ "type": "none" }` | `http-hook`: `url`, `email`, `tokenHeader`, `tokenFile` |
| `appRoot` | `#app` | element that must have children, else the frame is `blank` |
| `spinnerSelectors` | `[".spinner", "[aria-busy=true]"]` | a visible match marks the frame `loading` |
| `maxFrames` | `200` | oldest frames are evicted beyond this |
| `finishBudgetMs` | `25000` | how long `finish` waits for in-flight captures |
| `baseRef` | `main` | branch that `finish` diffs against |

Environment: `VISUAL_PROOF_STATUS_DIR` (default `/tmp/cursor/visual-proof`),
`VISUAL_PROOF_ARTIFACT_DIR` (default `/opt/cursor/artifacts`), `VISUAL_PROOF_SCRATCH_DIR`,
`VISUAL_PROOF_APP_URL`, `VISUAL_PROOF_VITE_URL`.

## Commands

```sh
npx visual-proof doctor     # check browser, trigger, HMR barrier, login, routes
npx visual-proof start      # start the watcher (reattaches if running); prints status JSON
npx visual-proof status     # status JSON; a dead watcher is reported as stale
npx visual-proof finish     # after committing: write the proof block, print its path
npx visual-proof stop
npx visual-proof watch      # run the watcher in the foreground
```

Options: `--config <path>`, `--json` (finish, doctor), `--hook` (finish: quiet,
time-capped, always exits 0). Run `npx visual-proof --help` for details.

| Exit | Meaning |
| --- | --- |
| 0 | ok (`finish`: every changed screen has a clean frame at HEAD, or none changed) |
| 1 | `finish`: proof failures; `doctor`: browser or trigger missing |
| 2 | usage error |
| 3 | setup or config error (invalid config, not a git repo, watcher cannot start) |
| 4 | internal error |

`finish` never falls back to an earlier clean frame: the final frame of each expected
route at HEAD must be `clean`. Failures and remedy hints go to stderr and into the proof
block.

## Files written

In the status dir:

- `daemon.pid`, `status.json` (state, pending work, last error, last finish)
- `watcher.log` (one line per event)
- `doctor.json` (last doctor report)
- `proof-block.md` (written by `finish` on every outcome)
- `scratch/index.jsonl` and `scratch/frames/<id>.png`

Headline stills are copied to the artifact dir as `<route-slug>-<shortTree>.png`.

## Planned (A4)

OpenRouter-backed model decisions (reviewing frames beyond the DOM heuristics) are
planned for milestone A4 and are not implemented.

## License

MIT, see [LICENSE](LICENSE).
