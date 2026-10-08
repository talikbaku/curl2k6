#!/usr/bin/env bash
# End-to-end demo of what curl2k6 does, without Claude and without CI:
#   1. run LOW / MEDIUM / HIGH against a healthy demo service  -> baseline
#   2. "deploy a bad release" (SLOW=1) and run the same profiles -> current
#   3. build the report tables + Raw numbers, compare with the baseline, flag regressions
#
# Needs: node >= 22, k6 (https://grafana.com/docs/k6/latest/set-up/install-k6/)
# Usage: bash examples/run-demo.sh [profiles...]      (default: low medium high)
#        COMPACT=1 bash examples/run-demo.sh          (print only the comparison at the end)
set -euo pipefail

cd "$(dirname "$0")"
command -v k6 >/dev/null || { echo "k6 is not installed — see https://grafana.com/docs/k6/latest/set-up/install-k6/"; exit 2; }

PROFILES=("${@:-low medium high}")
read -r -a PROFILES <<< "${PROFILES[*]}"
SCRIPTS=../plugins/curl2k6/skills/curl2k6/scripts
OUT=out
PORT=${PORT:-8099}
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo demo)
rm -rf "$OUT" && mkdir -p "$OUT/baseline" "$OUT/current"

SERVER_PID=""
stop_server() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""; }
trap stop_server EXIT

start_server() {
  stop_server
  PORT=$PORT SLOW=$1 node demo-server.mjs &
  SERVER_PID=$!
  for _ in $(seq 1 50); do
    node -e "fetch('http://127.0.0.1:$PORT/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && return 0
    sleep 0.1
  done
  echo "demo server did not start"; exit 2
}

run_profiles() { # $1 = output folder
  for p in "${PROFILES[@]}"; do
    echo "--- k6: profile $p -> $1"
    k6 run --quiet -e LOAD_PROFILE="$p" -e TARGET_ENV=local -e GIT_SHA="$GIT_SHA" -e BASE_URL="http://127.0.0.1:$PORT" -e OUT_DIR="$1" items-test.js \
      > "$1/k6-$p.log" 2>&1 || echo "    (k6 exit $? — thresholds crossed; the report will show which)"
    grep -E "^ +items_(latency|success):" "$1/k6-$p.log" | sed 's/^/    /' || true
  done
}

echo "=== 1/3 baseline: healthy service"
start_server 0
run_profiles "$OUT/baseline"
node "$SCRIPTS/to-raw.mjs" "$OUT"/baseline/summary-*.json --format json > "$OUT/baseline/raw.json"

echo "=== 2/3 current: after a simulated bad release (SLOW=1)"
start_server 1
run_profiles "$OUT/current"
node "$SCRIPTS/to-raw.mjs" "$OUT"/current/summary-*.json --format json > "$OUT/current/raw.json"
stop_server

echo "=== 3/3 report sections"
echo
node "$SCRIPTS/to-raw.mjs" "$OUT"/current/summary-*.json > "$OUT/current/results.md"
[ "${COMPACT:-0}" = 1 ] || cat "$OUT/current/results.md"   # COMPACT=1: comparison only (used for the README GIF)
[ "${COMPACT:-0}" = 1 ] || echo "## Comparison with previous run"
node "$SCRIPTS/compare.mjs" --prev "$OUT/baseline/raw.json" --curr "$OUT/current/raw.json" > "$OUT/current/comparison.md" || true
set +e
node "$SCRIPTS/compare.mjs" --prev "$OUT/baseline/raw.json" --curr "$OUT/current/raw.json" --format text --fail-on-regression
code=$?
set -e
echo
echo "Report sections written to $OUT/current/ (results.md, comparison.md)."
echo
if [ "$code" = 1 ]; then echo "compare.mjs --fail-on-regression exited 1 — regression detected, as expected for the SLOW release. That exit code is how a CI pipeline fails."; exit 0; fi
echo "compare.mjs exit $code"
exit "$code"
