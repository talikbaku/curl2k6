# items-api — 2026-10-09 — local — LOW / MEDIUM / HIGH (baseline)

> Example report produced by `examples/run-demo.sh` against the bundled demo service. Every number below was printed by `scripts/to-raw.mjs` from real k6 v1.5 runs — nothing was typed by hand. Demo profiles are 15 s long; real profiles are minutes.

## Summary

- **Verdict**: PASS — all thresholds passed on every profile (`items_success` rate>0.99, `items_latency_2xx` p95<300 ms).
- **Target**: `GET /items` on `local` (production: no)
- **Test script**: `examples/items-test.js` @ `512d292` (MR/PR: none — local demo)
- **Key finding**: latency stays nearly flat from LOW to HIGH (p95 29 → 35 ms at 7.5× the load); a handful of 503s (≤ 0.13%) — the service has headroom at 150 req/s.

## Results by profile (client side — k6)

| Profile | Peak VUs / rate | Duration | Requests | Success rate | p50 ms | p95 ms | p99 ms | max ms | Timeouts | 4xx | 5xx | Thresholds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| LOW | 20 req/s | 15s planned | 252 | 100.00% | 25.03 | 29.19 | 29.98 | 30.47 | 0 | 0 | 0 | PASS |
| MEDIUM | 60 req/s | 15s planned | 752 | 99.87% | 26.1 | 30.65 | 30.98 | 32 | 0 | 0 | 1 | PASS |
| HIGH | 150 req/s | 15s planned | 1877 | 99.89% | 30.06 | 35.06 | 36.34 | 39.58 | 0 | 0 | 2 | PASS |

Latency of **successful (2xx) requests only**:

| Profile | p95 ms (2xx) | p99 ms (2xx) |
|---|---|---|
| LOW | 29.19 | 29.98 |
| MEDIUM | 30.65 | 30.98 |
| HIGH | 35.06 | 36.34 |

Derived values:
- timeouts=0 (counter "items_timeouts" declared but had no samples) — LOW, MEDIUM, HIGH
- http_4xx=0 (counter "items_4xx" declared but had no samples) — LOW, MEDIUM, HIGH
- http_5xx=0 (counter "items_5xx" declared but had no samples) — LOW

Source: k6 run summary (`summary-<profile>.json`).

## Comparison with previous run

Baseline run — no previous report to compare with.

## Runs

| Profile | Start (UTC) | End (UTC) | CI run | Notes |
|---|---|---|---|---|
| LOW | 2026-10-09 02:06:16 | 2026-10-09 02:06:31 | | |
| MEDIUM | 2026-10-09 02:06:32 | 2026-10-09 02:06:47 | | |
| HIGH | 2026-10-09 02:06:47 | 2026-10-09 02:07:02 | | |

## Data sources

- k6 summary: local output folder (`examples/out/baseline/`).
- No time-series or server-side backend in the demo — whole-run aggregates only; "Over time" and "Server side" sections omitted.
- Units normalized to ms.

## Raw numbers (for future comparisons)

```json
{"test":"items-api","date":"2026-10-09","environment":"local","endpoint":"GET /items","script_commit":"512d292","latency_metric":"items_latency",
 "profiles": {
   "low": {"executor":"ramping-arrival-rate","target_rate_rps":20,"peak_vus":null,"iterations":null,"vus_max_observed":1,"started_at":"2026-10-09T02:06:16.943Z","finished_at":"2026-10-09T02:06:31.948Z","duration_s":15,"planned_duration_s":15,"requests":252,"success_rate":1,"p50_ms":25.03,"p95_ms":29.19,"p99_ms":29.98,"max_ms":30.47,"timeouts":0,"http_4xx":0,"http_5xx":0,"p95_ms_2xx":29.19,"p99_ms_2xx":29.98,"thresholds_passed":true},
   "medium": {"executor":"ramping-arrival-rate","target_rate_rps":60,"peak_vus":null,"iterations":null,"vus_max_observed":2,"started_at":"2026-10-09T02:06:32.273Z","finished_at":"2026-10-09T02:06:47.293Z","duration_s":15.02,"planned_duration_s":15,"requests":752,"success_rate":0.99867,"p50_ms":26.1,"p95_ms":30.65,"p99_ms":30.98,"max_ms":32,"timeouts":0,"http_4xx":0,"http_5xx":1,"p95_ms_2xx":30.65,"p99_ms_2xx":30.98,"thresholds_passed":true},
   "high": {"executor":"ramping-arrival-rate","target_rate_rps":150,"peak_vus":null,"iterations":null,"vus_max_observed":5,"started_at":"2026-10-09T02:06:47.659Z","finished_at":"2026-10-09T02:07:02.689Z","duration_s":15.03,"planned_duration_s":15,"requests":1877,"success_rate":0.998934,"p50_ms":30.06,"p95_ms":35.06,"p99_ms":36.34,"max_ms":39.58,"timeouts":0,"http_4xx":0,"http_5xx":2,"p95_ms_2xx":35.06,"p99_ms_2xx":36.34,"thresholds_passed":true}
 }}
```

## Appendix — queries used

None — no metrics backend was queried in the demo.

---
Generated with curl2k6 (Claude Code skill). Re-run or compare: ask Claude to use curl2k6 with this report as the baseline.
