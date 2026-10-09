# <test name> — <YYYY-MM-DD> — <environment> — <profiles run, e.g. LOW / MEDIUM / HIGH>

<!--
Report template for curl2k6 / curl2k6-runner. Written in English unless the user explicitly asked for another language.
The results tables and the Raw numbers block come from scripts/to-raw.mjs; the comparison section from scripts/compare.mjs — paste their output verbatim.
The same content goes to every destination: the markdown file as-is, the wiki page converted to the wiki's format.
Delete sections that have no data — but say in "Data sources" why they're missing. Never invent numbers.
-->

## Summary

- **Verdict**: PASS / FAIL / PARTIAL — one sentence why (which thresholds failed at which profile).
- **Target**: `<METHOD> <endpoint>` on `<environment>` (production: yes/no)
- **Test script**: `<repo>/<path>` @ `<commit sha>` (MR/PR: <link or "none">)
- **Key finding**: 1–3 sentences in plain language (e.g. "latency holds up to MEDIUM; at HIGH p95 grows 20× while errors stay ~0 → requests queue, not fail").

## Results by profile (client side — k6)

<output of `node scripts/to-raw.mjs <run folder>/summary-*.json --format md`>

Source: k6 run summary (`K6_SUMMARY_JSON` / `summary.json`).

## Over time (client side)

Per profile: when did latency/errors start to degrade (minute into the run, VU level at that moment)? Include a small table or chart of p95 by 1-min bucket if a time-series backend was available.

## Server side

Only if a server-side backend was available (Datadog APM, Prometheus service metrics, access logs in Elasticsearch, …).

| Profile | Endpoint/resource | Server p95 ms | Server p99 ms | Requests | Errors |
|---|---|---|---|---|---|

Notable correlations (DB query time, CPU, pod restarts, connection pool, …) — facts only, clearly marked hypotheses as hypotheses.

## Comparison with previous run

Only if a previous report for the same test exists. Otherwise write: "Baseline run — no previous report to compare with."

<output of `node scripts/compare.mjs --prev <previous report(s)> --curr <run folder>/raw.json`>

The script applies the regression rules (strictly greater than: p95/p99 worse by >20%, success rate down by >1 pp, timeout share up by >0.1 pp unless other thresholds were agreed; missing values → n/a, no flag) and labels flags on non-comparable runs. If the previous report had no Raw numbers block, say here that its numbers were parsed from tables.

## Runs

<output of `node scripts/to-raw.mjs <run folder>/summary-*.json --format runs`; add CI links for CI runs>

## Data sources

- k6 summary: read from <CI job log / artifact / pod logs / log system>
- <Backend>: <URL>, used ✓ / unavailable ✗ (reason)
- Units normalized to ms.

## Raw numbers (for future comparisons)

Machine-readable copy of the per-profile results — the next run's comparison reads this block, not the tables. Keep the keys stable. Unknown values are `null`, never 0.

<the Raw numbers block printed by scripts/to-raw.mjs — shape for reference:>

```json
{"test": "<test name>", "date": "<YYYY-MM-DD>", "environment": "<env>", "endpoint": "<METHOD path>", "script_commit": "<sha or null>", "latency_metric": "<k6 trend used for p50–p99>",
 "profiles": {
   "low": {"executor": null, "target_rate_rps": null, "peak_vus": null, "vus_max_observed": null, "duration_s": null, "planned_duration_s": null, "requests": null, "success_rate": null, "p50_ms": null, "p95_ms": null, "p99_ms": null, "max_ms": null, "timeouts": null, "http_4xx": null, "http_5xx": null, "p95_ms_2xx": null, "p99_ms_2xx": null, "thresholds_passed": null}
 }}
```

## Appendix — queries used

Every query exactly as executed, with its time window, so anyone can reproduce the numbers.

---
Generated with curl2k6 (Claude Code skill). Re-run or compare: ask Claude to use curl2k6 with this report as the baseline.
