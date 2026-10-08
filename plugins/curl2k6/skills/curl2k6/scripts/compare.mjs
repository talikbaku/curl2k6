#!/usr/bin/env node
// compare.mjs — deterministic comparison of a load-test run with the previous one.
//
// Usage:
//   node compare.mjs --prev <report.md|raw.json> [--prev <another per-profile report>] \
//                    --curr <report.md|raw.json> \
//                    [--p95 20] [--p99 20] [--success-pp 1] [--timeout-pp 0.1] \
//                    [--dedicated] [--format md|text|json] [--fail-on-regression]
//   md = report section (default), text = aligned terminal table (coloured on a TTY / FORCE_COLOR), json = everything
//
// Inputs are the "Raw numbers" JSON block of a report (or a bare JSON file with the same shape).
// Reports without that block (older format) make the script exit 2 — the caller then parses the
// tables itself, writes them into a raw JSON file, says so in the report, and runs this again.
//
// Rules (from the curl2k6 skill):
//   - regression = strictly greater than the threshold (exactly 20% is NOT flagged; float-safe)
//   - p95/p99 worse by > p95/p99 %; success rate down by > success-pp; timeout share up by > timeout-pp
//   - a value missing on either side -> n/a, no flag; never treated as 0
//   - comparability per profile: core = endpoint, environment, load (target rate, else peak VUs),
//     planned duration; secondary = script commit, executor, latency metric, test name
//   - flags on non-comparable / unconfirmed profiles are labelled and never count as a regression
//
// Exit codes: 0 ok, 1 regression found and --fail-on-regression given, 2 bad input.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_THRESHOLDS = { p95: 20, p99: 20, successPp: 1, timeoutPp: 0.1 };
const EPS = 1e-9;
const DEDICATED_ENVS = new Set(['local', 'localhost']);

export class NoRawBlockError extends Error {}

// ---------- input ----------

export function extractRaw(text, source = 'input') {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const idx = text.search(/^#{1,6}\s*Raw numbers/im);
  if (idx === -1) throw new NoRawBlockError(`${source}: no "Raw numbers" section`);
  const m = text.slice(idx).match(/```json\s*\n([\s\S]*?)```/);
  if (!m) throw new NoRawBlockError(`${source}: "Raw numbers" section has no json block`);
  return JSON.parse(m[1]);
}

// flatten a raw report into per-profile records carrying the top-level fields
export function records(raw, source) {
  const top = { ...raw };
  delete top.profiles;
  return Object.entries(raw.profiles || {}).map(([profile, p]) => ({ ...top, ...p, profile: profile.toLowerCase(), source }));
}

// several previous files (one per profile is common): the most recent record per profile wins
export function mergeLatest(recordLists) {
  const best = new Map();
  for (const r of recordLists.flat()) {
    const cur = best.get(r.profile);
    if (!cur || String(r.date || '') >= String(cur.date || '')) best.set(r.profile, r);
  }
  return best;
}

// ---------- comparability ----------

const known = (v) => v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v));
const normEndpoint = (e) => (known(e) ? String(e).trim().replace(/\s+/g, ' ').replace(/^(\w+)/, (m) => m.toUpperCase()) : null);
const normEnv = (e) => (known(e) ? String(e).trim().toLowerCase() : null);
export const normTest = (t) =>
  known(t) ? String(t).trim().toLowerCase().replace(/\.(js|ts)$/, '').replace(/[-_]?(load[-_]?)?test$/, '') : null;
const numEq = (a, b) => Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));

export function comparability(prev, curr) {
  const differs = [];
  const unknown = [];
  const notes = [];

  const core = (label, a, b, eq = (x, y) => x === y) => {
    if (!known(a) || !known(b)) unknown.push(`${label} (previous: ${known(a) ? a : 'unknown'}, current: ${known(b) ? b : 'unknown'})`);
    else if (!eq(a, b)) differs.push(`${label}: ${a} → ${b}`);
  };
  core('endpoint', normEndpoint(prev.endpoint), normEndpoint(curr.endpoint));
  core('environment', normEnv(prev.environment), normEnv(curr.environment));

  // load: target rate if both have it, else peak VUs (VU-based executors)
  const pr = known(prev.target_rate_rps);
  const cr = known(curr.target_rate_rps);
  if (pr && cr) core('target rate (req/s)', prev.target_rate_rps, curr.target_rate_rps, numEq);
  else if (!pr && !cr) core('peak VUs', prev.peak_vus, curr.peak_vus, numEq);
  else unknown.push('profile load (one run has a target rate, the other does not)');

  core('planned duration (s)', prev.planned_duration_s, curr.planned_duration_s, numEq);

  const secondary = (label, a, b, norm = (x) => x) => {
    if (!known(a) || !known(b)) notes.push(`${label} unknown on ${!known(a) && !known(b) ? 'both sides' : !known(a) ? 'previous side' : 'current side'}`);
    else if (norm(a) !== norm(b)) notes.push(`${label} differs: ${a} → ${b}`);
  };
  secondary('script commit', prev.script_commit, curr.script_commit);
  secondary('executor', prev.executor, curr.executor);
  secondary('latency metric', prev.latency_metric, curr.latency_metric);
  secondary('test name', prev.test, curr.test, normTest);

  const status = differs.length ? 'not-like-for-like' : unknown.length ? 'unconfirmed' : 'yes';
  return { status, differs, unknown, notes };
}

// ---------- deltas ----------

function pctChange(a, b) {
  if (!known(a) || !known(b) || a <= 0) return null;
  return ((b - a) / a) * 100;
}

export function compareProfile(prev, curr, th = DEFAULT_THRESHOLDS) {
  const comp = comparability(prev, curr);
  const rows = [];
  const add = (metric, p, c, delta, unit, isRegression) => {
    const flag = delta === null ? null : isRegression ? 'regression' : 'ok';
    rows.push({ metric, previous: known(p) ? p : null, current: known(c) ? c : null, delta, unit, flag });
  };

  const sr = known(prev.success_rate) && known(curr.success_rate) ? (curr.success_rate - prev.success_rate) * 100 : null;
  add('success rate', prev.success_rate, curr.success_rate, sr, 'pp', sr !== null && -sr > th.successPp + EPS);

  for (const [key, label, limit] of [['p95_ms', 'p95 ms', th.p95], ['p99_ms', 'p99 ms', th.p99]]) {
    const d = pctChange(prev[key], curr[key]);
    add(label, prev[key], curr[key], d, '%', d !== null && d > limit + EPS);
  }

  const share = (r) => (known(r.timeouts) && known(r.requests) && r.requests > 0 ? (r.timeouts / r.requests) * 100 : null);
  const ps = share(prev);
  const cs = share(curr);
  const td = ps !== null && cs !== null ? cs - ps : null;
  rows.push({
    metric: 'timeouts',
    previous: known(prev.timeouts) ? prev.timeouts : null,
    current: known(curr.timeouts) ? curr.timeouts : null,
    previous_share_pct: ps,
    current_share_pct: cs,
    delta: td,
    unit: 'pp of requests',
    flag: td === null ? null : td > th.timeoutPp + EPS ? 'regression' : 'ok',
  });

  const regressions = rows.filter((r) => r.flag === 'regression').map((r) => r.metric);
  return { profile: curr.profile, comparable: comp, rows, regressions, confirmed: comp.status === 'yes' ? regressions : [] };
}

export function compareRuns(prevRaws, currRaw, opts = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const prevBy = mergeLatest(prevRaws.map((p) => records(p.raw, p.source)));
  const profiles = [];
  for (const curr of records(currRaw, 'current')) {
    const prev = prevBy.get(curr.profile);
    if (!prev) profiles.push({ profile: curr.profile, baseline: true });
    else profiles.push({ ...compareProfile(prev, curr, th), previous_source: prev.source, previous_date: prev.date ?? null });
  }
  const env = normEnv(currRaw.environment);
  const caveat = !(opts.dedicated || DEDICATED_ENVS.has(env));
  const confirmed = profiles.flatMap((p) => (p.confirmed || []).map((m) => `${p.profile.toUpperCase()} ${m}`));
  return { thresholds: th, profiles, confirmed_regressions: confirmed, caveat };
}

// ---------- output ----------

const fmtNum = (v) => (v === null ? 'n/a' : String(Math.round(v * 100) / 100));
const fmtRate = (v) => (v === null ? 'n/a' : `${(Math.round(v * 10000) / 100).toFixed(2)}%`);
const sign = (v, digits) => (v === null ? 'n/a' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(digits)}`);

export function toMarkdown(result) {
  const out = [];
  const th = result.thresholds;
  const prevSources = [...new Set(result.profiles.filter((p) => !p.baseline).map((p) => `${p.previous_source}${p.previous_date ? ` (${p.previous_date})` : ''}`))];
  if (!prevSources.length) return 'Baseline run — no previous report to compare with.\n';
  out.push(`Previous report: ${prevSources.join(', ')}.`);
  out.push('');
  for (const p of result.profiles) {
    const name = p.profile.toUpperCase();
    if (p.baseline) {
      out.push(`- **${name}**: no previous data for this profile — baseline.`);
      continue;
    }
    const c = p.comparable;
    let line = c.status === 'yes' ? 'Comparable: yes' : c.status === 'not-like-for-like' ? `**not like-for-like** — ${c.differs.join('; ')}` : `**comparable: cannot be confirmed** — missing: ${c.unknown.join('; ')}`;
    if (c.status === 'not-like-for-like' && c.unknown.length) line += `; also unknown: ${c.unknown.join('; ')}`;
    if (c.notes.length) line += ` (notes: ${c.notes.join('; ')})`;
    out.push(`- **${name}**: ${line}`);
  }
  out.push('');
  out.push('| Profile | Metric | Previous | Current | Δ | |');
  out.push('|---|---|---|---|---|---|');
  for (const p of result.profiles) {
    if (p.baseline) continue;
    const suffix = p.comparable.status === 'not-like-for-like' ? ' (not like-for-like)' : p.comparable.status === 'unconfirmed' ? ' (unconfirmed)' : '';
    for (const r of p.rows) {
      let prev, curr, delta;
      if (r.metric === 'success rate') {
        prev = fmtRate(r.previous); curr = fmtRate(r.current); delta = r.delta === null ? 'n/a' : `${sign(r.delta, 2)} pp`;
      } else if (r.metric === 'timeouts') {
        const s = (n, sh) => (n === null ? 'n/a' : sh === null ? `${n}` : `${n} (${sh.toFixed(2)}%)`);
        prev = s(r.previous, r.previous_share_pct); curr = s(r.current, r.current_share_pct);
        delta = r.delta === null ? 'n/a' : `${sign(r.delta, 2)} pp`;
      } else {
        prev = fmtNum(r.previous); curr = fmtNum(r.current); delta = r.delta === null ? 'n/a' : `${sign(r.delta, 1)}%`;
      }
      const flag = r.flag === 'regression' ? `⚠ regression${suffix}` : r.flag === 'ok' ? '✓' : '';
      out.push(`| ${p.profile.toUpperCase()} | ${r.metric} | ${prev} | ${curr} | ${delta} | ${flag} |`);
    }
  }
  out.push('');
  out.push(`Regression flag (strictly greater than): p95 worse by >${th.p95}%, p99 worse by >${th.p99}%, success rate down by >${th.successPp} pp, timeout share up by >${th.timeoutPp} pp. Missing values → n/a, no flag.`);
  out.push('');
  out.push(result.confirmed_regressions.length
    ? `**Regressions on comparable profiles:** ${result.confirmed_regressions.join(', ')}.`
    : 'No regressions on comparable profiles.');
  if (result.caveat) {
    out.push('');
    out.push('> Shared or production environment: results vary with concurrent traffic. One difference is a signal, not proof — re-run before concluding a regression.');
  }
  return out.join('\n') + '\n';
}

// plain-terminal rendering: aligned columns, colours only when asked (TTY / FORCE_COLOR, never with NO_COLOR)
export function toText(result, { color = false } = {}) {
  const c = (code, t) => (color ? `\x1b[${code}m${t}\x1b[0m` : t);
  const red = (t) => c('1;31', t);
  const green = (t) => c('32', t);
  const yellow = (t) => c('33', t);
  const bold = (t) => c('1', t);
  const out = [];
  const compared = result.profiles.filter((p) => !p.baseline);
  if (!compared.length) return 'Baseline run — no previous report to compare with.\n';
  const src = [...new Set(compared.map((p) => `${p.previous_source}${p.previous_date ? ` (${p.previous_date})` : ''}`))].join(', ');
  out.push(bold(`Comparison with ${src}`));
  for (const p of result.profiles) {
    const name = p.profile.toUpperCase();
    if (p.baseline) out.push(`  ${name}: baseline (no previous data)`);
    else if (p.comparable.status === 'yes') out.push(`  ${name}: ${green('comparable')}`);
    else if (p.comparable.status === 'not-like-for-like') out.push(`  ${name}: ${yellow(`NOT like-for-like — ${p.comparable.differs.join('; ')}`)}`);
    else out.push(`  ${name}: ${yellow(`cannot be confirmed — missing ${p.comparable.unknown.join('; ')}`)}`);
  }
  out.push('');
  const rows = [['PROFILE', 'METRIC', 'PREVIOUS', 'CURRENT', 'CHANGE', '']];
  const flags = [];
  for (const p of compared) {
    const suffix = p.comparable.status === 'yes' ? '' : ' (unconfirmed)';
    for (const r of p.rows) {
      let prev, curr, delta;
      if (r.metric === 'success rate') { prev = fmtRate(r.previous); curr = fmtRate(r.current); delta = r.delta === null ? 'n/a' : `${sign(r.delta, 2)} pp`; }
      else if (r.metric === 'timeouts') { prev = r.previous === null ? 'n/a' : String(r.previous); curr = r.current === null ? 'n/a' : String(r.current); delta = r.delta === null ? 'n/a' : `${sign(r.delta, 2)} pp`; }
      else { prev = fmtNum(r.previous); curr = fmtNum(r.current); delta = r.delta === null ? 'n/a' : `${sign(r.delta, 1)}%`; }
      rows.push([p.profile.toUpperCase(), r.metric, prev, curr, delta, '']);
      flags.push(r.flag === 'regression' ? (suffix ? yellow(`⚠ regression${suffix}`) : red('⚠ regression')) : r.flag === 'ok' ? green('✓') : '');
    }
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  rows.forEach((r, i) => {
    const line = r.slice(0, 5).map((v, j) => (j >= 2 ? v.padStart(w[j]) : v.padEnd(w[j]))).join('   ');
    out.push(i === 0 ? bold(line) : `${line}   ${flags[i - 1]}`);
  });
  out.push('');
  const th = result.thresholds;
  out.push(`Thresholds: p95/p99 worse by >${th.p95}%/${th.p99}%, success rate down by >${th.successPp} pp, timeout share up by >${th.timeoutPp} pp`);
  out.push(result.confirmed_regressions.length ? red(`REGRESSION: ${result.confirmed_regressions.join(', ')}`) : green('No regressions on comparable profiles.'));
  if (result.caveat) out.push(yellow('Shared/production environment: one difference is a signal, not proof — re-run before concluding.'));
  return out.join('\n') + '\n';
}

// ---------- cli ----------

function main(argv) {
  const prev = [];
  let curr;
  let format = 'md';
  let failOnRegression = false;
  const opts = { thresholds: {} };
  const num = (v, flag) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${flag} needs a number`);
    return n;
  };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--prev') prev.push(argv[++i]);
      else if (a === '--curr') curr = argv[++i];
      else if (a === '--format') {
        format = argv[++i];
        if (!['md', 'json', 'text'].includes(format)) throw new Error('--format must be md, json or text');
      }
      else if (a === '--dedicated') opts.dedicated = true;
      else if (a === '--fail-on-regression') failOnRegression = true;
      else if (a === '--p95') opts.thresholds.p95 = num(argv[++i], a);
      else if (a === '--p99') opts.thresholds.p99 = num(argv[++i], a);
      else if (a === '--success-pp') opts.thresholds.successPp = num(argv[++i], a);
      else if (a === '--timeout-pp') opts.thresholds.timeoutPp = num(argv[++i], a);
      else if (a === '-h' || a === '--help') {
        console.log('usage: node compare.mjs --prev <report.md|raw.json> [--prev ...] --curr <report.md|raw.json> [--p95 20] [--p99 20] [--success-pp 1] [--timeout-pp 0.1] [--dedicated] [--format md|text|json] [--fail-on-regression]');
        return 0;
      } else throw new Error(`unknown argument ${a}`);
    }
    if (!curr) throw new Error('--curr is required');
    const currRaw = extractRaw(readFileSync(curr, 'utf8'), curr);
    const prevRaws = prev.map((f) => ({ source: f, raw: extractRaw(readFileSync(f, 'utf8'), f) }));
    const result = compareRuns(prevRaws, currRaw, opts);
    const color = !process.env.NO_COLOR && (Boolean(process.env.FORCE_COLOR) || process.stdout.isTTY === true);
    console.log(format === 'json' ? JSON.stringify(result, null, 2) : format === 'text' ? toText(result, { color }) : toMarkdown(result));
    return failOnRegression && result.confirmed_regressions.length ? 1 : 0;
  } catch (e) {
    console.error(`compare: ${e instanceof NoRawBlockError ? `${e.message} — parse the tables into a raw JSON file and pass that instead` : e.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
