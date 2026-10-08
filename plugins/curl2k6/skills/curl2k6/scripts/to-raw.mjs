#!/usr/bin/env node
// to-raw.mjs — turn k6 run summaries (summary-<profile>.json written by templates/summary.js)
// into the report's "Raw numbers" JSON block and the "Results by profile" markdown tables.
//
// Usage:
//   node to-raw.mjs summary-low.json summary-medium.json [--format json|md|runs|both] [--commit <sha>]
//
// Inputs: summary-<profile>.json files, or any log that contains "K6_SUMMARY_JSON {...}" lines
// (k6 stdout saved to a file, a CI job log, pod logs) — one or several profiles per log.
//
// Deterministic: no network, no dependencies. Unknown values are null, never 0 — except a counter
// that the test declared in meta.metrics but never incremented (k6 omits metrics without samples):
// that is reported as 0 and listed under "derived".

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const r2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 100) / 100);
const r6 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 1e6) / 1e6);

// one input file -> one or more summaries (JSON file, or K6_SUMMARY_JSON lines in a log)
export function readSummaries(text, source = 'input') {
  const t = text.trim();
  if (t.startsWith('{')) return [JSON.parse(t)];
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('K6_SUMMARY_JSON {');
    if (i !== -1) found.push(JSON.parse(line.slice(i + 'K6_SUMMARY_JSON '.length).trim()));
  }
  if (!found.length) throw new Error(`${source}: neither a summary JSON file nor a log with K6_SUMMARY_JSON lines`);
  return found;
}

const isoMinus = (iso, ms) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) || !ms ? null : new Date(t - ms).toISOString();
};

export function profileFromSummary(summary) {
  const meta = summary.meta || {};
  const mm = meta.metrics || {};
  const metrics = summary.metrics || {};
  const derived = [];
  const vals = (name) => (name && metrics[name] ? metrics[name].values : undefined);

  const latencyName = mm.latency || 'http_req_duration';
  const lat = vals(latencyName) || {};
  const lat2xxName = mm.latency_2xx || 'http_req_duration{expected_response:true}';
  const lat2xx = vals(lat2xxName) || {};

  let requests = null;
  let successRate = null;
  if (mm.success && vals(mm.success)) {
    const v = vals(mm.success);
    requests = (v.passes ?? 0) + (v.fails ?? 0);
    successRate = v.rate ?? null;
  } else if (vals('http_req_failed')) {
    const v = vals('http_req_failed');
    requests = vals('http_reqs') ? vals('http_reqs').count : (v.passes ?? 0) + (v.fails ?? 0);
    successRate = v.rate === undefined ? null : 1 - v.rate;
    if (mm.success) derived.push(`success metric "${mm.success}" missing — used 1 - http_req_failed`);
  }

  const counter = (key) => {
    const name = mm[key];
    if (!name) return null; // test did not declare such a counter -> unknown
    const v = vals(name);
    if (v) return v.count ?? null;
    derived.push(`${key}=0 (counter "${name}" declared but had no samples)`);
    return 0;
  };

  const thresholdsFailed = [];
  for (const [name, m] of Object.entries(metrics)) {
    for (const [expr, ok] of Object.entries(m.thresholds || {})) {
      if (!ok) thresholdsFailed.push(`${name}: ${expr}`);
    }
  }

  const plan = meta.plan || {};
  const vus = vals('vus') || {};
  return {
    executor: plan.executor ?? null,
    target_rate_rps: plan.target_rate_rps ?? null,
    peak_vus: plan.peak_vus ?? null,
    vus_max_observed: vus.max ?? null,
    started_at: meta.finished_at ? isoMinus(meta.finished_at, summary.test_run_duration_ms) : null,
    finished_at: meta.finished_at ?? null,
    duration_s: summary.test_run_duration_ms ? r2(summary.test_run_duration_ms / 1000) : null,
    planned_duration_s: plan.planned_duration_s ?? null,
    requests,
    success_rate: r6(successRate),
    p50_ms: r2(lat.med),
    p95_ms: r2(lat['p(95)']),
    p99_ms: r2(lat['p(99)']),
    max_ms: r2(lat.max),
    timeouts: counter('timeouts'),
    http_4xx: counter('http_4xx'),
    http_5xx: counter('http_5xx'),
    p95_ms_2xx: r2(lat2xx['p(95)']),
    p99_ms_2xx: r2(lat2xx['p(99)']),
    thresholds_passed: thresholdsFailed.length === 0,
    thresholds_failed: thresholdsFailed,
    derived,
  };
}

const PROFILE_ORDER = ['smoke', 'low', 'medium', 'high', 'stress', 'spike', 'soak'];

export function derivedNotes(raw) {
  // group identical notes: "timeouts=0 (...)" for low, medium, high -> one line
  const by = new Map();
  for (const [k, p] of Object.entries(raw.profiles)) {
    for (const d of p.derived || []) by.set(d, [...(by.get(d) || []), k.toUpperCase()]);
  }
  return [...by.entries()].map(([d, ps]) => `${d} — ${ps.join(', ')}`);
}

export function buildRaw(summaries, { commit } = {}) {
  if (!summaries.length) throw new Error('no summary files given');
  const metas = summaries.map((s) => s.meta || {});
  for (const key of ['test', 'environment', 'endpoint']) {
    const set = new Set(metas.map((m) => m[key] ?? null));
    if (set.size > 1) throw new Error(`summaries disagree on "${key}": ${[...set].join(' vs ')}`);
  }
  const m0 = metas[0];
  const dates = metas.map((m) => (m.date || m.finished_at || '').slice(0, 10)).filter(Boolean).sort();
  const unsorted = {};
  summaries.forEach((s, i) => {
    const key = String(metas[i].profile || `run${i + 1}`).toLowerCase();
    if (unsorted[key]) throw new Error(`profile "${key}" given twice`);
    unsorted[key] = profileFromSummary(s);
  });
  // canonical load order first (low < medium < high), anything else after, in the given order
  const rank = (k) => {
    const i = PROFILE_ORDER.indexOf(k);
    return i === -1 ? PROFILE_ORDER.length : i;
  };
  const keys = Object.keys(unsorted);
  const profiles = Object.fromEntries(
    keys.map((k, i) => [k, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([k]) => [k, unsorted[k]])
  );
  return {
    test: m0.test ?? null,
    date: dates.length ? dates[dates.length - 1] : null,
    environment: m0.environment ?? null,
    endpoint: m0.endpoint ?? null,
    script_commit: commit ?? m0.script_commit ?? null,
    latency_metric: (m0.metrics && m0.metrics.latency) || 'http_req_duration',
    profiles,
  };
}

const show = (v, suffix = '') => (v === null || v === undefined ? 'n/a' : `${v}${suffix}`);
const pct = (v) => (v === null || v === undefined ? 'n/a' : `${(Math.round(v * 10000) / 100).toFixed(2)}%`);

export function resultsTable(raw) {
  const lines = [
    '| Profile | Peak VUs / rate | Duration | Requests | Success rate | p50 ms | p95 ms | p99 ms | max ms | Timeouts | 4xx | 5xx | Thresholds |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  const lines2 = ['| Profile | p95 ms (2xx) | p99 ms (2xx) |', '|---|---|---|'];
  for (const [name, p] of Object.entries(raw.profiles)) {
    const load = p.target_rate_rps !== null ? `${p.target_rate_rps} req/s` : p.peak_vus !== null ? `${p.peak_vus} VUs` : 'n/a';
    const dur = p.planned_duration_s !== null ? `${p.planned_duration_s}s planned` : show(p.duration_s, 's');
    const th = p.thresholds_passed ? 'PASS' : `FAIL (${p.thresholds_failed.join('; ')})`;
    lines.push(`| ${name.toUpperCase()} | ${load} | ${dur} | ${show(p.requests)} | ${pct(p.success_rate)} | ${show(p.p50_ms)} | ${show(p.p95_ms)} | ${show(p.p99_ms)} | ${show(p.max_ms)} | ${show(p.timeouts)} | ${show(p.http_4xx)} | ${show(p.http_5xx)} | ${th} |`);
    lines2.push(`| ${name.toUpperCase()} | ${show(p.p95_ms_2xx)} | ${show(p.p99_ms_2xx)} |`);
  }
  return `${lines.join('\n')}\n\nLatency of **successful (2xx) requests only**:\n\n${lines2.join('\n')}\n`;
}

export function runsTable(raw) {
  const t = (iso) => (iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z').replace(/Z$/, '') : 'n/a');
  const lines = ['| Profile | Start (UTC) | End (UTC) | CI run | Notes |', '|---|---|---|---|---|'];
  for (const [name, p] of Object.entries(raw.profiles)) {
    lines.push(`| ${name.toUpperCase()} | ${t(p.started_at)} | ${t(p.finished_at)} | | |`);
  }
  return lines.join('\n') + '\n';
}

export function rawBlock(raw) {
  // stable keys, one profile per line — easy to diff and to read back
  const { profiles, ...top } = raw;
  const head = JSON.stringify(top).slice(0, -1);
  const body = Object.entries(profiles)
    .map(([k, v]) => {
      const { thresholds_failed, derived, ...rest } = v;
      return `   ${JSON.stringify(k)}: ${JSON.stringify(rest)}`;
    })
    .join(',\n');
  return '```json\n' + `${head},\n "profiles": {\n${body}\n }}\n` + '```\n';
}

function main(argv) {
  const files = [];
  let format = 'both';
  let commit;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') {
      format = argv[++i];
      if (!['json', 'md', 'runs', 'both'].includes(format)) {
        console.error('to-raw: --format must be json, md, runs or both');
        return 2;
      }
    }
    else if (a === '--commit') commit = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('usage: node to-raw.mjs <summary-low.json | k6-or-ci.log> [...] [--format json|md|runs|both] [--commit <sha>]');
      return 0;
    } else files.push(a);
  }
  if (!files.length) {
    console.error('to-raw: give at least one summary-<profile>.json or a log with K6_SUMMARY_JSON lines');
    return 2;
  }
  try {
    const raw = buildRaw(files.flatMap((f) => readSummaries(readFileSync(f, 'utf8'), f)), { commit });
    if (format === 'json') {
      console.log(JSON.stringify(raw, null, 2));
    } else {
      if (format === 'both' || format === 'md') {
        if (format === 'both') console.log('## Results by profile (client side — k6)\n');
        console.log(resultsTable(raw));
        const derived = derivedNotes(raw);
        if (derived.length) console.log(`Derived values:\n${derived.map((d) => `- ${d}`).join('\n')}\n`);
      }
      if (format === 'both' || format === 'runs') {
        if (format === 'both') console.log('## Runs\n');
        console.log(runsTable(raw));
      }
      if (format === 'both') {
        console.log('## Raw numbers (for future comparisons)\n');
        console.log(rawBlock(raw));
      }
    }
    return 0;
  } catch (e) {
    console.error(`to-raw: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
