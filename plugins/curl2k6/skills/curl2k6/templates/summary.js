// Backend-independent run summary for k6. No jslib imports (jslib.k6.io is often blocked in CI/k8s).
//
// Usage in a test script:
//   import { makeHandleSummary, planOf } from './summary.js';
//   export const options = { scenarios: { ... }, summaryTrendStats: ['avg','med','p(90)','p(95)','p(99)','max'] };
//   export const handleSummary = makeHandleSummary({
//     test: 'orders-api', environment: __ENV.TARGET_ENV || 'stage', endpoint: 'GET /orders',
//     profile: __ENV.LOAD_PROFILE || 'unknown', script_commit: __ENV.GIT_SHA || null,
//     plan: planOf(options),                       // executor, target rate / peak VUs / iterations, planned duration
//                                                  // (several scenarios: planOf(options, '<measured scenario>'))
//     out_dir: __ENV.OUT_DIR || null,              // output folder for the summary files — must already exist
//     metrics: { latency: 'orders_latency', latency_2xx: 'orders_latency_2xx', success: 'orders_success',
//                timeouts: 'orders_timeouts', http_4xx: 'orders_4xx', http_5xx: 'orders_5xx' },
//   });
//   (k6 does not compute p(99) by default — keep it in summaryTrendStats)
//
// Produces:
//   - a readable text table on stdout
//   - one log line "K6_SUMMARY_JSON <compact json>" — greppable in CI logs, pod logs, Kibana, Datadog Logs
//   - summary.json and summary-<profile>.json in the working dir, or in meta.out_dir (pass __ENV.OUT_DIR;
//     the folder must already exist)
//
// The `meta` block is what scripts/to-raw.mjs reads to build the report's "Raw numbers" block,
// and what scripts/compare.mjs uses to decide whether two runs are comparable.

function fmt(v) {
  if (v === undefined || v === null || Number.isNaN(v)) return '-';
  return typeof v === 'number' ? (Math.round(v * 100) / 100).toString() : String(v);
}

// k6 duration -> seconds. Like k6: a number is milliseconds; strings are Go-style durations
// ("1m30s", "500ms", "1.5m", ".5s", "1d2h"). Anything that doesn't fully parse -> null.
export function durationToSeconds(d) {
  if (d === undefined || d === null || d === '') return null;
  if (typeof d === 'number') return Number.isFinite(d) ? Math.round(d) / 1000 : null;
  const str = String(d).trim();
  if (!/^(?:\d*\.?\d+(?:ns|us|µs|ms|s|m|h|d))+$/.test(str)) return null;
  const mult = { ns: 1e-9, us: 1e-6, 'µs': 1e-6, ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };
  let total = 0;
  for (const m of str.matchAll(/(\d*\.?\d+)(ns|us|µs|ms|s|m|h|d)/g)) total += parseFloat(m[1]) * mult[m[2]];
  return Math.round(total * 1000) / 1000;
}

// Planned load of one scenario. Values that do not apply are null. With several scenarios pass the
// name of the measured one (planOf(options, 'main')) — otherwise the load can't be stated and every
// comparison of this run is "cannot be confirmed" rather than a false "comparable".
export function planOf(options, scenarioName) {
  const empty = (note, scenario = null) => ({ scenario, executor: null, target_rate_rps: null, peak_vus: null, iterations: null, planned_duration_s: null, note });
  const o = options || {};
  const scenarios = o.scenarios || {};
  const names = Object.keys(scenarios);
  if (names.length) {
    if (!scenarioName && names.length > 1) return empty(`several scenarios (${names.join(', ')}) — pass planOf(options, '<measured scenario>')`);
    const name = scenarioName || names[0];
    if (!scenarios[name]) return empty(`scenario "${name}" not found (have: ${names.join(', ')})`, name);
    return planOfScenario(name, scenarios[name]);
  }
  // classic options (no scenarios block) — k6 derives the executor from them
  if (o.stages) return planOfScenario(null, { executor: 'ramping-vus', stages: o.stages, startVUs: o.vus });
  if (o.iterations) return planOfScenario(null, { executor: 'shared-iterations', vus: o.vus, iterations: o.iterations, maxDuration: o.duration });
  if (o.duration) return planOfScenario(null, { executor: 'constant-vus', vus: o.vus, duration: o.duration });
  return empty('no scenarios, stages, iterations or duration in options');
}

function planOfScenario(name, s) {
  const tu = durationToSeconds(s.timeUnit || '1s') || 1;
  const stagesDur = (st) => st.reduce((a, x) => a + (durationToSeconds(x.duration) || 0), 0);
  const plan = { scenario: name, executor: s.executor, target_rate_rps: null, peak_vus: null, iterations: null, planned_duration_s: null };
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
      plan.peak_vus = s.vus ?? 1;
      plan.planned_duration_s = durationToSeconds(s.duration);
      break;
    case 'ramping-vus':
      plan.peak_vus = Math.max(s.startVUs ?? 1, ...s.stages.map((x) => x.target || 0));
      plan.planned_duration_s = stagesDur(s.stages);
      break;
    case 'shared-iterations': // k6 defaults: vus 1, iterations 1, maxDuration 10m (an upper bound)
      plan.peak_vus = s.vus ?? 1;
      plan.iterations = s.iterations ?? 1;
      plan.planned_duration_s = durationToSeconds(s.maxDuration ?? '10m');
      break;
    case 'per-vu-iterations':
      plan.peak_vus = s.vus ?? 1;
      plan.iterations = (s.vus ?? 1) * (s.iterations ?? 1);
      plan.planned_duration_s = durationToSeconds(s.maxDuration ?? '10m');
      break;
    default: // externally-controlled and anything newer
      plan.peak_vus = s.vus ?? s.maxVUs ?? null;
      plan.planned_duration_s = durationToSeconds(s.duration ?? s.maxDuration);
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
