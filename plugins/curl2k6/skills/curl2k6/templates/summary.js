// Backend-independent run summary for k6. No jslib imports (jslib.k6.io is often blocked in CI/k8s).
//
// Usage in a test script:
//   import { makeHandleSummary, planOf } from './summary.js';
//   export const options = { scenarios: { ... }, summaryTrendStats: ['avg','med','p(90)','p(95)','p(99)','max'] };
//   export const handleSummary = makeHandleSummary({
//     test: 'orders-api', environment: __ENV.TARGET_ENV || 'stage', endpoint: 'GET /orders',
//     profile: __ENV.LOAD_PROFILE || 'unknown', script_commit: __ENV.GIT_SHA || null,
//     plan: planOf(options),                       // executor, target rate / peak VUs, planned duration
//     metrics: { latency: 'orders_latency', latency_2xx: 'orders_latency_2xx', success: 'orders_success',
//                timeouts: 'orders_timeouts', http_4xx: 'orders_4xx', http_5xx: 'orders_5xx' },
//   });
//   (k6 does not compute p(99) by default — keep it in summaryTrendStats)
//
// Produces:
//   - a readable text table on stdout
//   - one log line "K6_SUMMARY_JSON <compact json>" — greppable in CI logs, pod logs, Kibana, Datadog Logs
//   - summary.json and summary-<profile>.json in the working dir, or in OUT_DIR (must already exist)
//
// The `meta` block is what scripts/to-raw.js reads to build the report's "Raw numbers" block,
// and what scripts/compare.js uses to decide whether two runs are comparable.

function fmt(v) {
  if (v === undefined || v === null || Number.isNaN(v)) return '-';
  return typeof v === 'number' ? (Math.round(v * 100) / 100).toString() : String(v);
}

// "1m30s" / "500ms" / "2h" / 90 (seconds) -> seconds
export function durationToSeconds(d) {
  if (d === undefined || d === null) return null;
  if (typeof d === 'number') return d;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  const mult = { ms: 0.001, s: 1, m: 60, h: 3600 };
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(String(d))) !== null) {
    total += parseFloat(m[1]) * mult[m[2]];
    matched = true;
  }
  return matched ? Math.round(total * 1000) / 1000 : null;
}

// Planned load of one scenario (default: the only/first one). Values that do not apply are null.
export function planOf(options, scenarioName) {
  const scenarios = (options && options.scenarios) || {};
  const name = scenarioName || Object.keys(scenarios)[0];
  const s = scenarios[name];
  if (!s) {
    // classic options.stages / options.vus+duration
    if (options && options.stages) {
      return {
        scenario: null, executor: 'ramping-vus', target_rate_rps: null,
        peak_vus: Math.max(...options.stages.map((x) => x.target || 0)),
        planned_duration_s: options.stages.reduce((a, x) => a + (durationToSeconds(x.duration) || 0), 0),
      };
    }
    return {
      scenario: null, executor: options && options.vus ? 'constant-vus' : null, target_rate_rps: null,
      peak_vus: (options && options.vus) || null,
      planned_duration_s: durationToSeconds(options && options.duration),
    };
  }
  const tu = durationToSeconds(s.timeUnit || '1s') || 1;
  const stagesDur = (st) => st.reduce((a, x) => a + (durationToSeconds(x.duration) || 0), 0);
  const plan = { scenario: name, executor: s.executor, target_rate_rps: null, peak_vus: null, planned_duration_s: null };
  switch (s.executor) {
    case 'constant-arrival-rate':
      plan.target_rate_rps = s.rate / tu;
      plan.planned_duration_s = durationToSeconds(s.duration);
      break;
    case 'ramping-arrival-rate':
      plan.target_rate_rps = Math.max(s.startRate || 0, ...s.stages.map((x) => x.target || 0)) / tu;
      plan.planned_duration_s = stagesDur(s.stages);
      break;
    case 'constant-vus':
      plan.peak_vus = s.vus;
      plan.planned_duration_s = durationToSeconds(s.duration);
      break;
    case 'ramping-vus':
      plan.peak_vus = Math.max(s.startVUs || 0, ...s.stages.map((x) => x.target || 0));
      plan.planned_duration_s = stagesDur(s.stages);
      break;
    default:
      plan.peak_vus = s.vus || s.maxVUs || null;
      plan.planned_duration_s = durationToSeconds(s.duration || s.maxDuration);
  }
  if (plan.target_rate_rps !== null) plan.target_rate_rps = Math.round(plan.target_rate_rps * 1000) / 1000;
  return plan;
}

function compact(data, meta) {
  const metrics = {};
  for (const [name, m] of Object.entries(data.metrics)) {
    metrics[name] = { type: m.type, values: m.values };
    if (m.thresholds) {
      metrics[name].thresholds = Object.fromEntries(
        Object.entries(m.thresholds).map(([t, r]) => [t, r.ok])
      );
    }
  }
  return {
    meta: Object.assign({ finished_at: new Date().toISOString() }, meta),
    test_run_duration_ms: data.state ? data.state.testRunDurationMs : undefined,
    metrics,
  };
}

function textTable(summary) {
  const lines = [`k6 summary (test=${summary.meta.test || '?'} profile=${summary.meta.profile || '?'})`];
  const names = Object.keys(summary.metrics).sort();
  for (const name of names) {
    const m = summary.metrics[name];
    const v = m.values;
    let row;
    if (m.type === 'trend') {
      row = `avg=${fmt(v.avg)} p(50)=${fmt(v.med)} p(90)=${fmt(v['p(90)'])} p(95)=${fmt(v['p(95)'])} p(99)=${fmt(v['p(99)'])} max=${fmt(v.max)}`;
    } else if (m.type === 'rate') {
      row = `rate=${fmt(v.rate === undefined ? undefined : v.rate * 100)}% true=${fmt(v.passes)} false=${fmt(v.fails)}`;
    } else if (m.type === 'counter') {
      row = `count=${fmt(v.count)} rate=${fmt(v.rate)}/s`;
    } else {
      row = Object.entries(v).map(([k, x]) => `${k}=${fmt(x)}`).join(' ');
    }
    const th = m.thresholds
      ? ' ' + Object.entries(m.thresholds).map(([t, ok]) => `[${ok ? 'PASS' : 'FAIL'} ${t}]`).join(' ')
      : '';
    lines.push(`  ${name}: ${row}${th}`);
  }
  return lines.join('\n') + '\n';
}

export function makeHandleSummary(meta = {}) {
  return function handleSummary(data) {
    const summary = compact(data, meta);
    const pretty = JSON.stringify(summary, null, 2);
    // optional output folder, e.g. -e OUT_DIR=results. k6 does NOT create folders: mkdir -p it before
    // the run, otherwise k6 logs "could not open ..." and still exits 0. The K6_SUMMARY_JSON stdout line
    // is written either way — save k6's output to a file and scripts/to-raw.mjs can read that instead.
    const base = meta.out_dir ? `${String(meta.out_dir).replace(/\/+$/, '')}/` : '';
    const out = {
      stdout: textTable(summary) + `K6_SUMMARY_JSON ${JSON.stringify(summary)}\n`,
      [`${base}summary.json`]: pretty,
    };
    if (meta.profile) out[`${base}summary-${String(meta.profile).toLowerCase()}.json`] = pretty;
    return out;
  };
}
