# vite-vue fixture

Tiny Vite + Vue 3 + vue-router app used as the target for visual-proof integration and corpus tests.

- Run: `npm install && npm run dev` (port 5173, override with `PORT=xxxx`).
- `vite.config.js`: dev-only middleware = the fake backend (`/api/*`, reads `server/data.json` per request), the token-gated `POST /__playwright__/login`, and the `.visual-proof/hot` freshness marker (written on start, removed on close) plus `.visual-proof/token`.
- `src/router/index.js`: static page imports (import-graph resolution), one param route, one nested route, one dynamic `import()` route, and a guard sending `/manage/*` to `/login` on 401.
- `StatusBadge.vue`: shared by InvoiceList and InvoiceDetail (fan-out case). Pages show `.spinner` while loading.
- `server/data.json`: edited by backend-only corpus tests. `visual-proof.config.json`: config the tool loads.
- `src/pages/Long.vue` + `src/layouts/ScrollLayout.vue` (`/long`): the document never scrolls, an inner container does (full-page capture tests; a green bottom marker, a sticky header). `index.html` holds a fake `#__vue-devtools-container__` pill (hide-selector tests).
- `src/pages/Flagged.vue` (`/flagged`) mounts `src/components/FlaggedDetails.vue` only when `server/data.json` `flags.showDetails` is true, served by `/api/flags` (render-check tests).
- `VP_FIXTURE_CACHE_DIR` gives the dev server its own dependency cache (cold-start tests).
