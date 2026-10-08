# Changelog

## 1.2.0 — 2026-10-08

First public release (renamed from `k6-load-test` to `curl2k6`).

### Added
- `scripts/compare.mjs` — deterministic comparison with the previous report: deltas, regression flags (strictly-greater, float-safe), comparability (`yes` / `not like-for-like` / `cannot be confirmed`), one-file-per-profile merging, reads the Raw numbers block straight from markdown reports, `--fail-on-regression` for CI gating.
- `scripts/to-raw.mjs` — builds the "Results by profile" tables and the Raw numbers block from `summary-<profile>.json` files.
- `planOf(options)` in `templates/summary.js` — records executor, target rate / peak VUs and planned duration in every run, so comparisons can be confirmed instead of guessed.
- `templates/test-template.js` — test skeleton with the agreed metric layout.
- Local runs as a first-class path (skill can run short local profiles itself).
- `examples/` — zero-dependency demo service, generated test example, run-demo script, real example reports (baseline + regression).
- Unit tests (`npm test`) and a GitHub Actions workflow (unit tests + k6 end-to-end demo).

- Azure DevOps support: `templates/azure-pipelines.yml`, `references/ci-azure-devops.md` (`az pipelines create/run/runs show/artifact download`, profile via runtime parameters, push-before-run, self-hosted pools, approvals, secret mapping), `examples/azure-pipelines.demo.yml` (self-contained demo), `docs/azure-devops.md` (first real run checklist), offline checks in `tests/azure/` (official schema, job emulator, `az` emulator) and in CI.
- A previous report that exists only as a wiki page (Confluence): its Raw numbers block is saved to a local file and passed to `compare.mjs` — no comparison by hand.

### Fixed (found by running the skill end-to-end in Claude Code)
- "Re-run the load test / did the release get slower?" did not trigger the skill → description now covers re-runs and regression checks; generated tests and reports carry a "Generated with curl2k6" marker.
- `OUT_DIR` that doesn't exist made k6 silently skip the summary files (exit code 0) → the skill creates the folder first, and `to-raw.mjs` can read the `K6_SUMMARY_JSON` line from a saved k6 / CI log.
- Local runs recorded the commit from *before* the test was committed → commit first, then run with `GIT_SHA`.
- The "Runs" section was left out of reports → `to-raw.mjs --format runs` prints it (UTC start/end).

### Changed
- `compare.mjs --format text`: aligned, coloured terminal table (CI logs, demo).
- Agent renamed `load-test-runner` → `curl2k6-runner`; it now calls the scripts instead of doing report arithmetic in prose.
- Report template: Raw numbers placeholders are `null` (were `0`); results and comparison sections are script output pasted verbatim.
- `summary.js` writes `summary-<profile>.json` (and honours `OUT_DIR`) in addition to `summary.json`.
- Repo layout: single source of truth (plugin marketplace at the repo root) instead of duplicated `plugin/` and `manual-install/` copies.

## 1.1.0

- Generic version of an internal team skill: curl → k6 test → CI runs across profiles → metrics from Prometheus-compatible stores, Grafana, Datadog, Elasticsearch/Kibana, InfluxDB → markdown/Confluence report → comparison with the previous report.
