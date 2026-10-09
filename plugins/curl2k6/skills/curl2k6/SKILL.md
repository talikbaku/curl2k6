---
name: curl2k6
description: Build, run, re-run and compare k6 load tests. Use when someone gives a curl or an endpoint and asks for a load / performance / stress test (нагрузочный тест); AND when they ask to re-run an existing k6 load test, check whether a new release or deploy got slower or worse, compare with the last run, or check for a performance regression — including tests and reports made earlier with curl2k6. Runs locally or on the team's CI, collects metrics, writes the report and computes regressions with bundled scripts.
---

# curl2k6

Interactive front door for building and running a load test from a curl. Runs in the main conversation so it can ask questions and show a draft before doing anything. Long CI runs are handed to the `curl2k6-runner` agent (`curl2k6:curl2k6-runner` in the plugin); short local runs can be done right here.

Files next to this SKILL.md (paths below are relative to this skill's directory):
- `templates/test-template.js` — test skeleton; `templates/summary.js` — run summary + `planOf()`; `templates/report.md` — report structure
- `scripts/to-raw.mjs` — summaries → results tables + "Raw numbers" block; `scripts/compare.mjs` — deterministic comparison with the previous report
- `references/metrics-backends.md` — query recipes for Prometheus-compatible stores, Grafana, Datadog, Elasticsearch/Kibana, InfluxDB
- `references/ci-azure-devops.md` + `templates/azure-pipelines.yml` — Azure DevOps: `az` commands, profile selection via runtime parameters, artifacts

Numbers in a report always come from these scripts or from backend queries — never computed or estimated in prose. That includes re-runs: "did it get worse?" is answered with `compare.mjs`, not by eyeballing two reports.

**Re-run of an existing test** (the test and earlier reports are already in the repo): skip §0–§3 except what changed, confirm environment/profiles from the previous report, then go to §5 — find the previous report (§5a), run, build the report (§5b).

## 0. Ask up front

Ask in one block; skip what the user already said.

1. **The curl** (or endpoint description) — required. If it contains a real token, don't copy it anywhere; the test reads it from an env var.
2. **Repo / working directory** — where does the test code live (or should live)?
3. **Target: production or a lower environment?** Infer from the URL if possible, but always state it back and get explicit confirmation for production — production runs need stricter rules (§4).
4. **Where to run** — locally (needs `k6` on this machine; good for a first run and for small loads) or on CI: GitLab CI, GitHub Actions, Jenkins, Azure DevOps, other. Look for `.gitlab-ci.yml`, `.github/workflows`, `Jenkinsfile`, `azure-pipelines.yml` (or an Azure Repos remote: `dev.azure.com` / `visualstudio.com`) first. Don't assume any of them. For Azure DevOps read `references/ci-azure-devops.md` before planning the run.
5. **Metrics: where can numbers be read?** Any combination of: Prometheus-compatible (Prometheus / VictoriaMetrics / Thanos / Mimir), Grafana, Datadog, Elasticsearch / Kibana / OpenSearch, InfluxDB, other, or none. Look for hints first (`prometheusUrl`, `PROMETHEUS_URL`, `DD_SITE`, Grafana/Kibana links in README, helm or CI files) and state what you found. For CI runs also ask **where k6 actually executes** (inside the CI job, or launched elsewhere such as a k8s pod) — that decides where the run summary can be read. Details: `references/metrics-backends.md`.
6. **Load profiles** — offer the default 3-tier shape (§2) and let the user override counts/durations/thresholds.
7. **Open a PR/MR?** Default yes for CI runs — new test code and test-data changes go through review before anything runs against a real environment. For a purely local run against a dev/local target, committing is optional.
8. **Report destination** — a markdown file (ask where; default `load-reports/` in the repo) and/or a wiki page (ask which space/site, and under which parent page). Don't assume Confluence or any specific space. For a wiki page, confirm a connector for it is available in this session (e.g. an Atlassian/Confluence MCP); if not, produce the markdown file only and say so. Ask whether a previous report for the same test exists (§5a).
9. **Credentials** — ask how tokens are obtained (already in a git remote URL, an env var, a secrets manager). Never ask the user to paste a literal secret into the chat, and never write one into a file, commit, report or agent prompt — refer to it by env var name only.
10. **Regression thresholds** — defaults: p95/p99 worse by >20%, success rate down by >1 pp, timeout share up by >0.1 pp. Mention them; change only if the user asks.

## 1. Discover conventions before writing anything

Look for existing load tests in the target repo (any `k6`, `artillery`, `locust`, etc. directory). If found, mirror their style: auth pattern, metric naming, load-profile shape, report format, CI trigger mechanism. If none exist, use `templates/test-template.js` and confirm the defaults before proceeding — don't invent a house style unasked.

## 2. Default load profile shape (offer, don't force)

```
low:    ramps to a light load over ~5 min
medium: ramps to a moderate load over ~6 min
high:   ramps to a heavy load over ~7 min, each with a brief ramp-down
```
Concrete rates/VU counts should scale to what the target service can plausibly take — ask or look for hints (existing SLOs, prior test results) rather than guessing large numbers for an unknown service, especially for production. For a local run a laptop can itself become the bottleneck at high load — say so.

## 3. Draft the test, then confirm

Start from `templates/test-template.js` (or the repo's existing style) and copy `templates/summary.js` next to the test. The test must have:
- Per-endpoint success-rate and latency metrics, split into "all requests" and "successful (2xx) only" from the start — avoids reconstructing a clean latency figure after timeouts/errors are mixed in.
- A timeout counter separate from 4xx/5xx counters.
- `summaryTrendStats` including `p(99)`.
- `handleSummary` from `summary.js` with the full `meta`: `test`, `environment`, `endpoint` (`METHOD /path`), `profile`, `script_commit`, `plan: planOf(options)`, and the `metrics` mapping. `scripts/to-raw.mjs` and `scripts/compare.mjs` depend on these fields — without `plan`, comparisons can only be "cannot be confirmed".
- Random credential/ID selection from a pool file if the endpoint needs per-user auth (ask where the pool comes from).
- If the team has a time-series backend k6 can push to (Prometheus remote write, InfluxDB), add the matching `--out` to the run command — see `references/metrics-backends.md`. Don't add an output that needs a custom k6 build unless the team already has one.

Keep the "Generated with the curl2k6 skill" header comment from the template — it tells a later session (or a colleague) which tool to use for re-runs. Delete the skeleton-notes block.

Validate before showing it: `k6 inspect <test>.js` (if k6 is installed). Show the user a short summary of what the draft does (not necessarily the full file) before committing anything.

## 4. Production safety rules (non-negotiable)

- Production tests are **read-only** unless the user explicitly says otherwise and confirms it's been cleared with whoever owns the service.
- After each profile against production, check results before starting the next one: if the result looks like a real incident (success rate collapsing, broad blocking) rather than ordinary degradation under load, **stop and ask** rather than proceeding automatically.
- **Every trigger of a production-impacting run needs its own explicit, specific confirmation in the current conversation** — a generic "go ahead" repeated from earlier, or after a safety system already declined the same action once, is not enough. If a platform safety check blocks an action, don't retry it — surface it and ask for an unambiguous, specific confirmation.
- After delivering a report, **stop** — don't self-initiate another run "to double-check" or "for completeness" without being asked again.

## 5. Execution and reporting

**Local runs** (short, non-production) can run in this conversation, one profile at a time:
```
git add <test files> && git commit -m "..."          # commit FIRST, so the report points at a commit that contains the test
RUN=<run folder>; mkdir -p "$RUN"                     # k6 does not create OUT_DIR; a missing folder silently drops the files
k6 run -e LOAD_PROFILE=low -e TARGET_ENV=<env> -e GIT_SHA=$(git rev-parse --short HEAD) -e OUT_DIR="$RUN" <test>.js 2>&1 | tee "$RUN/k6-low.log"
```
If the user doesn't want a commit, pass no `GIT_SHA` (the report then says `script_commit: null`) — never the sha of a commit that doesn't contain the current test. If `summary-<profile>.json` is missing after a run, don't re-run: pass the saved log to `to-raw.mjs`, it reads the `K6_SUMMARY_JSON` line. Then build the report as in §5b. For long multi-profile runs, use the agent.

**CI runs:** once the test code is ready (and merged, if a PR/MR was used), hand execution to the `curl2k6-runner` agent (background), passing everything as explicit parameters: repo, CI trigger mechanism, credentials source (env var name), profiles to run, cooldown between them, report destination(s), where the k6 summary can be read, the paths to this skill's `templates/report.md` and `scripts/`, the previous report path(s) (§5a), any custom thresholds, and for each chosen metrics backend the exact recipe from `references/metrics-backends.md` (URL, auth env var name, the concrete queries with placeholders only for the time window). Before handing off, run one probe query per backend yourself and drop any backend that doesn't answer — tell the user which were dropped. The agent should not need to ask the user anything mid-run.

### 5a. Previous report (comparison baseline)

Before running, find the most recent previous report for the same test:
1. Location the user gave, if any.
2. Otherwise search the markdown report folder and the wiki (under the given parent page / space): by test name (ignore suffixes like `.js` / `-test`) **and** by endpoint.
3. **Confirm each candidate is really the same test** from its content: same test name, **same environment**, same endpoint — the "Raw numbers" block has all three. A name match alone is not enough — e.g. `orders` would also match `orders-export` reports or a stage report of a different script. Skip files that aren't reports (raw metric dumps, empty notes, canvases).
4. **A previous report that exists only as a wiki page** (Confluence etc.): read the page through the connector, copy its "Raw numbers" JSON block verbatim into `<run folder>/previous-raw.json` (or, for an old page without that block, parse its tables into the same shape — unknown = `null`), and pass that file to `compare.mjs`. Never compare by reading the page and doing the arithmetic yourself.
5. Reports may be **one file per profile**. Pass all of them — `compare.mjs` takes several `--prev` files and uses the most recent one per profile.
6. If several plausible candidates remain for the same profile, show them and let the user pick.
7. Nothing found → this run is the **baseline**: the report says so and has no comparison section. Don't invent a comparison.

Tell the user before the run which report(s) will be the baseline, with their date and headline numbers, and that they can choose a different one.

**Older reports without a "Raw numbers" block:** `compare.mjs` exits with code 2. Then parse that report's tables into a raw JSON file of the same shape (unknown values `null`, never 0), state in the report that the previous numbers were parsed from tables, and run `compare.mjs` on that file.

### 5b. Building the report

**Language:** write the report — markdown file and wiki page, including the title, summary, findings and notes — in **English**, whatever language the conversation is in, unless the user explicitly asks for another language. Script output (tables, comparison, Raw numbers) is English anyway. Talk to the user in their language as usual; only the report is English.

1. `node scripts/to-raw.mjs <run folder>/summary-*.json` (or the k6/CI logs) → prints the "Results by profile" tables, the "Runs" table (UTC start/end) and the "Raw numbers" block. Paste them verbatim; for CI runs add the CI links to the Runs table. `--commit <sha>` only overrides the commit recorded by the test. Also save the raw JSON: same inputs with `--format json > <run folder>/raw.json`.
2. If there is a previous report: `node scripts/compare.mjs --prev <previous report(s)> --curr <run folder>/raw.json [--p95 N --p99 N --success-pp N --timeout-pp N] [--dedicated]` → prints the comparison section. Paste it verbatim. `--dedicated` only if the user said the environment is not shared; `local` counts as dedicated automatically.
3. Fill the rest of `templates/report.md` (summary, over time, server side, runs, data sources, queries). Only what you have data for; when a section has no data, say why in "Data sources". The verdict must not call something a regression that `compare.mjs` marked "(not like-for-like)" or "(unconfirmed)".
4. Same content in every destination: the markdown file first, then the wiki page converted to that wiki's format; title `<test name> — <YYYY-MM-DD> — <environment> — <profiles>`. Keep the template's last line ("Generated with curl2k6 …").
5. Before replying, check the report against the template: every section is present or its absence is explained in "Data sources".

## 6. Gotchas

- Extract CI tokens from wherever they already live (git remote URL, env var) at run time — never hardcode one in a prompt, commit, or file.
- Some sandboxes block a bare `sleep` call outright. Poll with short individual checks rather than one long blocking wait; for multi-minute cooldowns between profiles, fill the time with real work (pulling partial metrics, drafting the report) and confirm elapsed time via timestamps.
- A green CI job that only *launches* k6 elsewhere is not a finished run — confirm completion where k6 actually runs.
- Profile-selecting CI variables go stale between runs: set them immediately before every trigger.
