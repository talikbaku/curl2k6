# curl2k6 — details

Everything that used to be in the README. Short version: [README](../README.md). Full flow: [GUIDE](GUIDE.md).

## No curl? Start from what you already have

| You have | Ask Claude | What happens |
|---|---|---|
| a curl | paste it | the test is built from it |
| a **HAR** from browser DevTools (Network → *Save all as HAR*) | *"load-test the items call from shop.har"* | API calls are listed (static files and preflights hidden), you pick one |
| a **Postman** collection | *"load-test 'List items' from shop.postman_collection.json"* | folders, `{{variables}}` and inherited auth are resolved |
| an **OpenAPI** spec | *"load-test GET /v2/items from openapi.yaml"* | Claude picks the operation and fills parameters from the spec's examples |

**Your tokens never reach the chat.** A HAR carries live cookies and bearer tokens, so Claude doesn't open it — the bundled extractor does, and swaps every secret for an env variable first:

```console
$ node request-from.mjs shop.har --list
shop.har: HAR, 7 request(s), 4 static/preflight hidden (--all shows them)
   1  GET    200 https://shop.example.com/catalog
   5  GET    200 https://api.example.com/v2/items?limit=50
   6  POST   201 https://api.example.com/v2/cart

$ node request-from.mjs shop.har --pick 5
curl 'https://api.example.com/v2/items?limit=50' \
  -H 'Authorization: Bearer '"$API_TOKEN" \
  -H 'Cookie: '"$COOKIE" \
  -H 'Accept: application/json'
secret: header Authorization → $API_TOKEN (the test reads it from the environment; the value was not copied)
secret: header Cookie → $COOKIE (the test reads it from the environment; the value was not copied)
```

## Why not just ask Claude to write a k6 script?

The script is the easy part. This plugin handles what breaks around it:

- **The verdict is computed, not eyeballed by an LLM.** `compare.mjs` applies fixed, configurable rules (p95/p99 worse by >20%, success rate down by >1 pp, timeout share up by >0.1 pp) and is unit-tested — including the float edge case at exactly 20%.
- **No apples-to-oranges.** Different environment, load or duration → *not like-for-like*; a missing field → *cannot be confirmed*; missing data stays `n/a`, never 0. None of these is ever called a regression.
- **Production runs need explicit confirmation** — every run, one profile at a time, with an automatic stop when results look like an incident.
- **Secrets stay in env vars.** Never written into tests, commits or reports; HAR and Postman imports get tokens and cookies swapped for `$ENV` placeholders before anything reaches the conversation; the Azure template scrubs them from published artifacts, validates pipeline parameters and only loads hosts you allow.
- **Your stack, your history.** Runs in your CI, reads your monitoring, writes to your wiki and repo — no vendor cloud, and every report is a reviewable file in git.
- **Fits the repo it lands in.** Mirrors the auth, naming and profile style of load tests you already have instead of inventing a new one.
- **Handles known traps:** CI jobs that go green before k6 finishes, profile variables that silently stay at the old value, unit mix-ups between backends, a run that sends zero requests and still "passes".

## How it compares

Grafana's mcp-k6 helps an assistant write, validate and run k6 scripts; Grafana Cloud k6's test comparison compares runs inside Grafana Cloud. curl2k6 needs no Grafana Cloud account: it runs k6 locally or in your existing CI, pulls server-side numbers from the Prometheus, Grafana, Datadog or Elasticsearch you already have, keeps every report as a versioned markdown file in your repo, and leaves the "did it get slower?" call to a zero-dependency script you can also gate a pipeline on — the LLM never decides it.

## Supported

| | |
|---|---|
| **Input** | curl · HAR (any browser's DevTools) · Postman collection v2.0 / v2.1 · OpenAPI / Swagger spec — one request per test |
| **Run** | **locally** — verified · **Azure DevOps** — hardened pipeline template + `az` recipe, verified on one real organization ([checklist](azure-devops.md); Linux/macOS agents with bash, and GitHub access or a preinstalled k6) · **GitLab CI, GitHub Actions, Jenkins** — Claude drives your team's existing pipeline with generic instructions; no bundled templates yet, and only GitLab has been used in practice (with an earlier version) |
| **Metrics** | k6 summary (always, no backend needed) · Prometheus / VictoriaMetrics / Thanos / Mimir · Grafana · Datadog (MCP or API) · Elasticsearch / Kibana / OpenSearch · InfluxDB |
| **Reports** | markdown file · Confluence or any wiki Claude has a connector for · Azure DevOps Wiki (via `az devops wiki`) — written in English by default |

What has and hasn't been verified against real systems: [GUIDE §14](GUIDE.md#14-what-has-and-hasnt-been-verified).

## Profiles and defaults

| Profile | Load (requests/s) | Duration | Purpose |
|---|---|---|---|
| smoke | 1 | 20 s | proves the target answers (status codes, auth) before a real profile |
| low | ramp to 5 | ~5.5 min | light load |
| medium | ramp to 20 | ~6.5 min | moderate load |
| high | ramp to 50 | ~7.5 min | heavy load |

Defaults the skill offers — sized to your service on request ("profiles 10 / 50 / 200 req/s"). k6 thresholds: success rate > 99%, p95 of 2xx responses < 500 ms, at least one request sent. Regression rules: p95/p99 worse by > 20%, success rate down by > 1 pp, timeout share up by > 0.1 pp — change them in plain words ("regression if p95 is worse by 10%") or with `compare.mjs` flags.

## Scope and limits

- **One endpoint per test.** Built from one request (a curl, a HAR entry, a Postman request or an OpenAPI operation). ID/credential pools are supported; multi-step flows (login → token → call) are not generated automatically — ask Claude to extend the script.
- **One run against one run.** No statistical model of run-to-run noise. On shared environments the report says a difference is a signal, not proof — re-run before concluding.
- **Baseline:** the most recent matching report by default. Pin an accepted baseline by naming it ("compare with load-reports/orders-api-2026-09-01-stage-low.md") or passing it to `compare.mjs --prev`.
- **What Claude asks before acting:** committing the test, every production run (one profile at a time), creating CI pipelines. It never asks you to paste a token and doesn't start extra runs after the report.

## Use in CI without Claude

`to-raw.mjs` and `compare.mjs` are zero-dependency Node scripts — copy them next to your k6 test (from `plugins/curl2k6/skills/curl2k6/scripts/`) and gate any pipeline on a pinned baseline. GitHub Actions example:

```yaml
on:
  workflow_dispatch:
    inputs:
      profile: { type: choice, options: [smoke, low, medium, high], default: low }
permissions: { contents: read }
jobs:
  load:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: grafana/setup-k6-action@v1
        with: { k6-version: '2.3.0' }
      - name: k6 run                       # inputs go through env — never pasted into the script
        env: { LOAD_PROFILE: "${{ inputs.profile }}", API_TOKEN: "${{ secrets.API_TOKEN }}" }
        run: mkdir -p out && k6 run -e TARGET_ENV=stage -e OUT_DIR=out load/orders.js 2>&1 | tee out/k6.log
      - name: Regression gate              # runs even when k6 thresholds failed the previous step
        if: always()
        run: |
          node load/to-raw.mjs out/summary-*.json --format json > out/raw.json
          node load/compare.mjs --prev load-reports/baseline.md --curr out/raw.json --format text --color --fail-on-regression
```

`--fail-on-regression` exits 1 only for regressions on comparable profiles; exit 2 means bad input (the message says which). `--format text --color` prints an aligned, coloured table for CI logs.
