# items-api — 2026-10-08 — local — LOW / MEDIUM / HIGH

> Example report produced by `examples/run-demo.sh` after "deploying a bad release" of the demo service (`SLOW=1`). Tables, Runs and the Raw numbers block come from `scripts/to-raw.mjs`; the comparison section is the verbatim output of `scripts/compare.mjs --prev reports/items-api-2026-10-08-local-baseline.md --curr out/current/raw.json`.

## Summary

- **Verdict**: FAIL — `items_success` rate>0.99 failed on LOW, MEDIUM, HIGH; `items_latency_2xx` p95<300 ms still passes.
- **Target**: `GET /items` on `local` (production: no)
- **Test script**: `examples/items-test.js` @ `edc6a6a` (MR/PR: none — local demo)
- **Key finding**: compared with the baseline the release is slower at every load level and degrades much faster with load — p95 +44% at LOW but +164% at HIGH (35 → 93 ms) — and returns 1.2–2.7% 503s. All profiles are comparable, so this is a confirmed regression, not noise from a different setup.

## Results by profile (client side — k6)

| Profile | Peak VUs / rate | Duration | Requests | Success rate | p50 ms | p95 ms | p99 ms | max ms | Timeouts | 4xx | 5xx | Thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| LOW | 20 req/s | 15s planned | 252 | 98.41% | 37.66 | 42.11 | 43.09 | 44.15 | 0 | 0 | 4 | FAIL (items_success: rate>0.99) |
| MEDIUM | 60 req/s | 15s planned | 752 | 98.80% | 44.39 | 49.73 | 50.59 | 74.77 | 0 | 0 | 9 | FAIL (items_success: rate>0.99) |
| HIGH | 150 req/s | 15s planned | 1877 | 97.34% | 85.39 | 93.13 | 94.16 | 118.43 | 0 | 0 | 50 | FAIL (items_success: rate>0.99) |

Latency of **successful (2xx) requests only**:

| Profile | p95 ms (2xx) | p99 ms (2xx) |
|---|---|---|
| LOW | 42.11 | 43.1 |
| MEDIUM | 49.68 | 50.6 |
| HIGH | 93.16 | 94.16 |

Derived values:
- timeouts=0 (counter "items_timeouts" declared but had no samples) — LOW, MEDIUM, HIGH
- http_4xx=0 (counter "items_4xx" declared but had no samples) — LOW, MEDIUM, HIGH

Source: k6 run summary (`summary-<profile>.json`).

## Comparison with previous run

Previous report: reports/items-api-2026-10-08-local-baseline.md (2026-10-08).

- **LOW**: Comparable: yes
- **MEDIUM**: Comparable: yes
- **HIGH**: Comparable: yes

| Profile | Metric | Previous | Current | Δ | |
|---|---|---|---|---|---|
| LOW | success rate | 99.21% | 98.41% | −0.79 pp | ✓ |
| LOW | p95 ms | 29.22 | 42.11 | +44.1% | ⚠ regression |
| LOW | p99 ms | 30.2 | 43.09 | +42.7% | ⚠ regression |
| LOW | timeouts | 0 (0.00%) | 0 (0.00%) | ±0.00 pp | ✓ |
| MEDIUM | success rate | 100.00% | 98.80% | −1.20 pp | ⚠ regression |
| MEDIUM | p95 ms | 30.64 | 49.73 | +62.3% | ⚠ regression |
| MEDIUM | p99 ms | 31.05 | 50.59 | +62.9% | ⚠ regression |
| MEDIUM | timeouts | 0 (0.00%) | 0 (0.00%) | ±0.00 pp | ✓ |
| HIGH | success rate | 99.95% | 97.34% | −2.61 pp | ⚠ regression |
| HIGH | p95 ms | 35.26 | 93.13 | +164.1% | ⚠ regression |
| HIGH | p99 ms | 36.5 | 94.16 | +158.0% | ⚠ regression |
| HIGH | timeouts | 0 (0.00%) | 0 (0.00%) | ±0.00 pp | ✓ |

Regression flag (strictly greater than): p95 worse by >20%, p99 worse by >20%, success rate down by >1 pp, timeout share up by >0.1 pp. Missing values → n/a, no flag.

**Regressions on comparable profiles:** LOW p95 ms, LOW p99 ms, MEDIUM success rate, MEDIUM p95 ms, MEDIUM p99 ms, HIGH success rate, HIGH p95 ms, HIGH p99 ms.

## Runs

| Profile | Start (UTC) | End (UTC) | CI run | Notes |
|---|---|---|---|---|
| LOW | 2026-10-08 21:04:05 | 2026-10-08 21:04:20 | | |
| MEDIUM | 2026-10-08 21:04:20 | 2026-10-08 21:04:36 | | |
| HIGH | 2026-10-08 21:04:36 | 2026-10-08 21:04:51 | | |

## Data sources

- k6 summary: local output folder (`examples/out/current/`).
- Previous report: `reports/items-api-2026-10-08-local-baseline.md` (Raw numbers block).
- No time-series or server-side backend in the demo — whole-run aggregates only; "Over time" and "Server side" sections omitted.
- Units normalized to ms.

## Raw numbers (for future comparisons)

```json
{"test":"items-api","date":"2026-10-08","environment":"local","endpoint":"GET /items","script_commit":"edc6a6a","latency_metric":"items_latency",
 "profiles": {
   "low": {"executor":"ramping-arrival-rate","target_rate_rps":20,"peak_vus":null,"vus_max_observed":1,"started_at":"2026-10-08T21:04:05.613Z","finished_at":"2026-10-08T21:04:20.624Z","duration_s":15.01,"planned_duration_s":15,"requests":252,"success_rate":0.984127,"p50_ms":37.66,"p95_ms":42.11,"p99_ms":43.09,"max_ms":44.15,"timeouts":0,"http_4xx":0,"http_5xx":4,"p95_ms_2xx":42.11,"p99_ms_2xx":43.1,"thresholds_passed":false},
   "medium": {"executor":"ramping-arrival-rate","target_rate_rps":60,"peak_vus":null,"vus_max_observed":3,"started_at":"2026-10-08T21:04:20.989Z","finished_at":"2026-10-08T21:04:36.028Z","duration_s":15.04,"planned_duration_s":15,"requests":752,"success_rate":0.988032,"p50_ms":44.39,"p95_ms":49.73,"p99_ms":50.59,"max_ms":74.77,"timeouts":0,"http_4xx":0,"http_5xx":9,"p95_ms_2xx":49.68,"p99_ms_2xx":50.6,"thresholds_passed":false},
   "high": {"executor":"ramping-arrival-rate","target_rate_rps":150,"peak_vus":null,"vus_max_observed":15,"started_at":"2026-10-08T21:04:36.408Z","finished_at":"2026-10-08T21:04:51.498Z","duration_s":15.09,"planned_duration_s":15,"requests":1877,"success_rate":0.973362,"p50_ms":85.39,"p95_ms":93.13,"p99_ms":94.16,"max_ms":118.43,"timeouts":0,"http_4xx":0,"http_5xx":50,"p95_ms_2xx":93.16,"p99_ms_2xx":94.16,"thresholds_passed":false}
 }}
```

## Appendix — queries used

None — no metrics backend was queried in the demo.

---
Generated with curl2k6 (Claude Code skill). Re-run or compare: ask Claude to use curl2k6 with this report as the baseline.
