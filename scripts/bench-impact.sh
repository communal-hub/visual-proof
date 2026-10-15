#!/usr/bin/env bash
# Hill-climb measurement: one run of the 200-route impact benchmark at the default config; prints one JSON object.
# batchMs (save -> batch fully captured), claimFrameMs (save -> claim screen's frame), msPerCapture, settleMs,
# screenshotMs, captures, nonClean and stale (frames that do not show the save; both must stay 0).
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -t vp-bench.XXXXXX).json"
VP_BENCH=1 VP_BENCH_CONCURRENCY=default VP_BENCH_SAMPLES="${VP_BENCH_SAMPLES:-3}" VP_BENCH_OUT="$out" \
  npx vitest run test/integration/impact-bench.test.ts > "$out.log" 2>&1 || { tail -40 "$out.log" >&2; exit 1; }
cat "$out"
