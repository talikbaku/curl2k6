# Metrics backends — how to get numbers out of whatever the team has

Two layers. Layer A is mandatory and backend-independent. Layer B is whatever the team actually has — use one or several, skip the rest.

## Common rules (all backends)

- **Time window**: record run start/end in UTC from the CI/run itself (not "about 5 min ago"). Query `start - 1m … end + 1m`, step ~15s.
- **Client vs server**: k6 numbers = latency as the client sees it. Backend/APM numbers = what the service saw. Report them in separate sections and never mix them in one table.
- **Units**: normalize everything to ms in the report. Common traps: Datadog span `@duration` is **nanoseconds** while Datadog `trace.*` metrics are **seconds**; Prometheus histograms are usually **seconds**, and so are k6 trends pushed via Prometheus remote write (`k6_http_req_duration_p95` = 0.098 means 98 ms); Elasticsearch fields may be µs (`event.duration` in ECS is **nanoseconds**).
- **Reproducibility**: put every query you ran (with the exact time window) in a report appendix.
- **Credentials**: refer to them only by the env var name the user gives you (ask which env var holds the key for that backend) and never echo the value. If none exists, ask the user to export one in their own terminal — never to paste it into the chat.
- **Before relying on a backend, run one tiny probe query** (e.g. last 5 min, one series) and confirm it returns data. If the probe fails, say which backend failed and continue with Layer A rather than guessing.

## Layer A — k6 run summary (always)

Use `templates/summary.js` (`makeHandleSummary`) in every test and set `summaryTrendStats` to include `p(99)`. It prints a text table and one line `K6_SUMMARY_JSON {…}` to stdout and writes `summary.json`.

Where to read it from depends on where k6 actually ran:
- k6 runs inside the CI job → CI job log (grep `K6_SUMMARY_JSON`) or `summary.json` as a job artifact.
- CI job only **launches** k6 elsewhere (k8s pod, separate runner, cloud) → the CI job log will NOT contain it. Read pod logs (`kubectl logs`), or search the `K6_SUMMARY_JSON` line in the team's log system (Kibana / Datadog Logs / Loki). Confirm this during discovery — a "successful" launcher job is not a finished run.
- Local run → stdout / `summary.json`.

Layer A gives whole-run aggregates only (no time series). That is enough for a pass/fail report; Layer B adds "when did it degrade" and server-side cause.

## Layer B — time series and server-side metrics

### B1. Prometheus or Prometheus-compatible (Prometheus, VictoriaMetrics, Thanos, Mimir, Cortex)

- Getting k6 metrics in: `k6 run --out experimental-prometheus-rw` with `K6_PROMETHEUS_RW_SERVER_URL=<remote-write URL>` and `K6_PROMETHEUS_RW_TREND_STATS=p(95),p(99),max`. VictoriaMetrics accepts remote write at `/api/v1/write`.
- Names: prefix `k6_`, trends become `k6_<metric>_p95` etc. (gauges per flush — fine for time series, not a whole-run aggregate; take aggregates from Layer A).
- Query: `GET <url>/api/v1/query_range?query=<promql>&start=<unix>&end=<unix>&step=15s`.
- Probe: `GET <url>/api/v1/label/__name__/values` and grep `k6_`.
- Server side: whatever the service exports (e.g. `histogram_quantile(0.95, sum by (le) (rate(http_server_requests_seconds_bucket{service="X"}[1m])))`) — find real metric names via the label API, don't guess.

### B2. Grafana (front-end for any datasource)

Grafana is not a store — it proxies to Prometheus / Loki / Elasticsearch / InfluxDB / etc. Use it when that's the only thing the user has access to.
- Auth: service account token, `Authorization: Bearer $<VAR the user named>`.
- List datasources: `GET <grafana>/api/datasources` → note `uid` and `type`.
- **Best path — reuse an existing dashboard panel's query** instead of writing one from scratch: `GET <grafana>/api/search?query=<name>` → `GET <grafana>/api/dashboards/uid/<uid>` → `dashboard.panels[].targets[]` (and `panels[].panels[]` for rows). The datasource is often set on the **panel**, not on the target — take `panel.datasource.uid` when the target has none. Substitute template vars (`$service`, `$__rate_interval` → `1m`, etc.).
- Run a query: `POST <grafana>/api/ds/query` with
  ```json
  {"from":"<ms epoch>","to":"<ms epoch>","queries":[{"refId":"A","datasource":{"uid":"<uid>"},"expr":"<promql>","intervalMs":15000,"maxDataPoints":1000}]}
  ```
  The query fields depend on datasource type: Prometheus/VictoriaMetrics → `expr`; Loki → `expr` (LogQL); InfluxDB → `query`; Elasticsearch → `query` + `metrics` + `bucketAggs`. Copy the shape from a dashboard panel of the same datasource type.
- Response: `results.A.frames[].data.values` = `[[timestamps…],[values…]]`.

### B3. Datadog

- **If a Datadog MCP server is connected, prefer it** (no keys needed): metrics via its metric query tool, APM via span aggregation tools. Probe with one small query first.
- Otherwise API with `DD-API-KEY` and `DD-APPLICATION-KEY` headers from the env vars the user named; site varies (`api.datadoghq.com`, `api.datadoghq.eu`, `api.us5.datadoghq.com`, …) — ask the user, or use `$DD_SITE` if it is set.
  - Timeseries: `GET https://api.<site>/api/v1/query?from=<unix>&to=<unix>&query=<query>`.
- Getting k6 metrics in (optional, usually not worth it): the built-in `statsd` output was **removed in k6 v0.55** — it needs a custom k6 binary built with the xk6-output-statsd extension (`K6_STATSD_ADDR=<dd-agent>:8125`, `K6_STATSD_ENABLE_TAGS=true`, metrics arrive as `k6.*`). Check `k6 version` first; if the team doesn't already have such a build, skip this and rely on Layer A + server-side APM below.
- Server side without any k6 output (often the most useful): APM trace metrics for the target service. **Find the real metric name first** (search metrics with `trace` + tag `service:<svc>`) — it depends on the tracer/integration, e.g. `trace.http.server.request`, `trace.http.request`, `trace.servlet.request`, `trace.postgresql.query`. Then:
  - latency: `p95:trace.http.server.request{service:<svc>} by {resource_name}` (values in **seconds**)
  - volume: `sum:trace.http.server.request.hits{service:<svc>} by {resource_name}.as_count()`
  - errors: `sum:trace.http.server.request.errors{service:<svc>} by {resource_name}.as_count()`
  A whole-window scalar of a p95 metric is an *average of per-interval p95s* — fine for comparing profiles, but quote peaks from the timeseries, not the scalar.
- Span-level (APM search/aggregate): duration field is **`@duration` in nanoseconds**; DB spans are usually `type:sql`. APM is sampled — counts are a subset, percentiles are fine.

### B4. Elasticsearch / Kibana (OpenSearch is API-compatible)

Usually holds **logs** (service access logs, ingress logs), not k6 metrics.
- Prefer the Elasticsearch API directly: `POST <es>/<index-pattern>/_search`. If only Kibana is reachable: `POST <kibana>/api/console/proxy?path=<index-pattern>/_search&method=POST` with header `kbn-xsrf: true` (same body).
- **Filter on keyword fields.** With default dynamic mapping, strings are `text` + `.keyword`; a `term` filter on the `text` field (e.g. `service.name`) silently returns **0 hits** — use `service.name.keyword`. Check `_mapping`.
- Discover before querying: index pattern, timestamp field, latency field **and its unit**, status-code field, service/route field. Use `GET <es>/<index>/_mapping` or take them from an existing Kibana visualization; confirm units with the user if ambiguous.
- Whole-window percentiles + status split:
  ```json
  {"size":0,
   "query":{"bool":{"filter":[
     {"range":{"@timestamp":{"gte":"<ISO start>","lte":"<ISO end>"}}},
     {"term":{"<service field>":"<svc>"}}]}},
   "aggs":{
     "lat":{"percentiles":{"field":"<latency field>","percents":[50,95,99]}},
     "status":{"terms":{"field":"<status field>","size":20}},
     "ts":{"date_histogram":{"field":"@timestamp","fixed_interval":"15s"},
           "aggs":{"p95":{"percentiles":{"field":"<latency field>","percents":[95]}}}}}}
  ```
- The Layer A `K6_SUMMARY_JSON` line can also be found here if pod logs are shipped: query `message:"K6_SUMMARY_JSON"` in the run window.

### B5. InfluxDB

- Getting k6 metrics in: `k6 run --out influxdb=http://<host>:8086/<db>` (InfluxDB 1.x; for 2.x use the xk6-output-influxdb extension).
- InfluxQL: `SELECT percentile("value",95) FROM "http_req_duration" WHERE time >= '<start>' AND time <= '<end>' GROUP BY time(15s)`.

### B6. Anything else / nothing

Use Layer A only and state in the report: "No time-series backend available — whole-run aggregates only; no server-side correlation." Don't invent a backend integration on the fly against an unknown API without the user confirming the endpoint and auth.
