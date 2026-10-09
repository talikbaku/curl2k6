# items-api — 2026-10-09 — local — LOW / MEDIUM / HIGH

> Example report produced by `examples/run-demo.sh` after "deploying a bad release" of the demo service (`SLOW=1`). Tables, Runs and the Raw numbers block come from `scripts/to-raw.mjs`; the comparison section is the verbatim output of `scripts/compare.mjs --prev reports/items-api-2026-10-09-local-baseline.md --curr out/current/raw.json`.

## Summary

- **Verdict**: FAIL — `items_success` rate>0.99 failed on LOW, MEDIUM, HIGH; `items_latency_2xx` p95<300 ms still passes.
- **Target**: `GET /items` on `local` (production: no)
- **Test script**: `examples/items-test.js` @ `512d292` (MR/PR: none — local demo)
- **Key finding**: compared with the baseline the release is slower at every load level and degrades much faster with load — p95 +44% at LOW but +165% at HIGH (35 → 93 ms) — and returns 1.6–2.4% 503s. All profiles are comparable, so this is a confirmed regression, not noise from a different setup.

## Results by profile (client side — k6)

| Profile | Peak VUs / rate | Duration | Requests | Success rate | p50 ms | p95 ms | p99 ms | max ms | Timeouts | 4xx | 5xx | Thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| LOW | 20 req/s | 15s planned | 252 | 97.62% | 37.81 | 41.95 | 42.13 | 42.36 | 0 | 0 | 6 | FAIL (items_success: rate>0.99) |
| MEDIUM | 60 req/s | 15s planned | 752 | 98.40% | 44.63 | 49.59 | 50.08 | 52.56 | 0 | 0 | 12 | FAIL (items_success: rate>0.99) |
| HIGH | 150 req/s | 15s planned | 1877 | 97.98% | 85.73 | 92.93 | 94.12 | 112.35 | 0 | 0 | 38 | FAIL (items_success: rate>0.99) |

Latency of **successful (2xx) requests only**:

| Profile | p95 ms (2xx) | p99 ms (2xx) |
|---|---|---|
| LOW | 41.96 | 42.13 |
| MEDIUM | 49.6 | 50.09 |
| HIGH | 92.94 | 94.13 |

Derived values:
- timeouts=0 (counter "items_timeouts" declared but had no samples) — LOW, MEDIUM, HIGH
- http_4xx=0 (counter "items_4xx" declared but had no samples) — LOW, MEDIUM, HIGH

Source: k6 run summary (`summary-<profile>.json`).

## Comparison with previous run

Previous report: reports/items-api-2026-10-09-local-baseline.md (2026-10-09).

- **LOW**: Comparable: yes
- **MEDIUM**: Comparable: yes
- **HIGH**: Comparable: yes

| Profile | Metric | Previous | Current | Δ | |
|---|---|---|---|---|---|
| LOW | success rate | 100.00% | 97.62% | −2.38 pp | ⚠ regression |
| LOW | p95 ms | 29.19 | 41.95 | +43.7% | ⚠ regression |
| LOW | p99 ms | 29.98 | 42.13 | +40.5% | ⚠ regression |
| LOW | timeouts | 0 (0.00%) | 0 (0.00%) | ±0.00 pp | ✓ |
| MEDIUM | success rate | 99.87% | 98.40% | −1.46 pp | ⚠ regression |
| MEDIUM | p95 ms | 30.65 | 49.59 | +61.8% | ⚠ regression |
| MEDIUM | p99 ms | 30.98 | 50.08 | +61.7% | ⚠ regression |
| MEDIUM | timeouts | 0 (0.00%) | 0 (0.00%) | ±0.00 pp | ✓ |
| HIGH | success rate | 99.89% | 97.98% | −1.92 pp | ⚠ regression |
| HIGH | p95 ms | 35.06 | 92.93 | +165.1% | ⚠ regression |
| HIGH | p99 ms | 36.34 | 94.12 | +159.0% | ⚠ regression |
| HIGH | timeouts | 0 (0.00%) | 0 (0.00%) | ±0.00 pp | ✓ |

Regression flag (strictly greater than): p95 worse by >20%, p99 worse by >20%, success rate down by >1 pp, timeout share up by >0.1 pp. Missing values → n/a, no flag.

**Regressions on comparable profiles:** LOW success rate, LOW p95 ms, LOW p99 ms, MEDIUM success rate, MEDIUM p95 ms, MEDIUM p99 ms, HIGH success rate, HIGH p95 ms, HIGH p99 ms.

## Runs

| Profile | Start (UTC) | End (UTC) | CI run | Notes |
|---|---|---|---|---|
| LOW | 2026-10-09 02:07:03 | 2026-10-09 02:07:18 | | |
| MEDIUM | 2026-10-09 02:07:18 | 2026-10-09 02:07:33 | | |
| HIGH | 2026-10-09 02:07:34 | 2026-10-09 02:07:49 | | |

## Data sources

- k6 summary: local output folder (`examples/out/current/`).
- Previous report: `reports/items-api-2026-10-09-local-baseline.md` (Raw numbers block).
- No time-series or server-side backend in the demo — whole-run aggregates only; "Over time" and "Server side" sections omitted.
- Units normalized to ms.

## Raw numbers (for future comparisons)

```json
{"test":"items-api","date":"2026-10-09","environment":"local","endpoint":"GET /items","script_commit":"512d292","latency_metric":"items_latency",
 "profiles": {
   "low": {"executor":"ramping-arrival-rate","target_rate_rps":20,"peak_vus":null,"iterations":null,"vus_max_observed":1,"started_at":"2026-10-09T02:07:03.488Z","finished_at":"2026-10-09T02:07:18.497Z","duration_s":15.01,"planned_duration_s":15,"requests":252,"success_rate":0.97619,"p50_ms":37.81,"p95_ms":41.95,"p99_ms":42.13,"max_ms":42.36,"timeouts":0,"http_4xx":0,"http_5xx":6,"p95_ms_2xx":41.96,"p99_ms_2xx":42.13,"thresholds_passed":false},
   "medium": {"executor":"ramping-arrival-rate","target_rate_rps":60,"peak_vus":null,"iterations":null,"vus_max_observed":3,"started_at":"2026-10-09T02:07:18.813Z","finished_at":"2026-10-09T02:07:33.853Z","duration_s":15.04,"planned_duration_s":15,"requests":752,"success_rate":0.984043,"p50_ms":44.63,"p95_ms":49.59,"p99_ms":50.08,"max_ms":52.56,"timeouts":0,"http_4xx":0,"http_5xx":12,"p95_ms_2xx":49.6,"p99_ms_2xx":50.09,"thresholds_passed":false},
   "high": {"executor":"ramping-arrival-rate","target_rate_rps":150,"peak_vus":null,"iterations":null,"vus_max_observed":14,"started_at":"2026-10-09T02:07:34.227Z","finished_at":"2026-10-09T02:07:49.311Z","duration_s":15.08,"planned_duration_s":15,"requests":1877,"success_rate":0.979755,"p50_ms":85.73,"p95_ms":92.93,"p99_ms":94.12,"max_ms":112.35,"timeouts":0,"http_4xx":0,"http_5xx":38,"p95_ms_2xx":92.94,"p99_ms_2xx":94.13,"thresholds_passed":false}
 }}
```

## Appendix — queries used

None — no metrics backend was queried in the demo.

---
Generated with curl2k6 (Claude Code skill). Re-run or compare: ask Claude to use curl2k6 with this report as the baseline.
