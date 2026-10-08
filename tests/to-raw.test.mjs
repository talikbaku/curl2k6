import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRaw, profileFromSummary, rawBlock, resultsTable } from '../plugins/curl2k6/skills/curl2k6/scripts/to-raw.mjs';
import { extractRaw } from '../plugins/curl2k6/skills/curl2k6/scripts/compare.mjs';

const summary = (over = {}) => ({
  meta: {
    finished_at: '2026-10-08T20:00:00.000Z', test: 'items', environment: 'local', endpoint: 'GET /items', profile: 'LOW',
    plan: { executor: 'ramping-arrival-rate', target_rate_rps: 20, peak_vus: null, planned_duration_s: 30 },
    metrics: { latency: 'items_latency', latency_2xx: 'items_latency_2xx', success: 'items_success', timeouts: 'items_timeouts', http_4xx: 'items_4xx', http_5xx: 'items_5xx' },
    ...over.meta,
  },
  test_run_duration_ms: 30512.4,
  metrics: {
    items_latency: { type: 'trend', values: { med: 12.345, 'p(95)': 80.555, 'p(99)': 150, max: 1000.8 } },
    items_latency_2xx: { type: 'trend', values: { 'p(95)': 70, 'p(99)': 90 } },
    items_success: { type: 'rate', values: { rate: 0.97, passes: 582, fails: 18 }, thresholds: { 'rate>0.99': false } },
    items_5xx: { type: 'counter', values: { count: 12 } },
    items_timeouts: { type: 'counter', values: { count: 6 } },
    vus: { type: 'gauge', values: { max: 7 } },
    ...over.metrics,
  },
});

test('extracts per-profile numbers from the mapped metrics', () => {
  const p = profileFromSummary(summary());
  assert.equal(p.requests, 600);
  assert.equal(p.success_rate, 0.97);
  assert.equal(p.p50_ms, 12.35);
  assert.equal(p.p95_ms, 80.56);
  assert.equal(p.timeouts, 6);
  assert.equal(p.http_5xx, 12);
  assert.equal(p.target_rate_rps, 20);
  assert.equal(p.planned_duration_s, 30);
  assert.equal(p.duration_s, 30.51);
  assert.equal(p.thresholds_passed, false);
  assert.deepEqual(p.thresholds_failed, ['items_success: rate>0.99']);
});

test('declared counter without samples is 0 and listed as derived', () => {
  const p = profileFromSummary(summary());
  assert.equal(p.http_4xx, 0);
  assert.ok(p.derived.some((d) => d.startsWith('http_4xx=0')));
});

test('undeclared counter is null, never 0', () => {
  const s = summary({ meta: { metrics: { latency: 'items_latency' } } });
  const p = profileFromSummary(s);
  assert.equal(p.timeouts, null);
  assert.equal(p.http_4xx, null);
});

test('falls back to http_req_failed / http_reqs when no success metric is mapped', () => {
  const s = summary({ meta: { metrics: {} }, metrics: { http_req_failed: { type: 'rate', values: { rate: 0.1, passes: 10, fails: 90 } }, http_reqs: { type: 'counter', values: { count: 100 } }, http_req_duration: { type: 'trend', values: { 'p(95)': 5 } } } });
  const p = profileFromSummary(s);
  assert.equal(p.requests, 100);
  assert.equal(p.success_rate, 0.9);
  assert.equal(p.p95_ms, 5);
});

test('buildRaw merges profiles and refuses summaries of different tests', () => {
  const raw = buildRaw([summary(), summary({ meta: { profile: 'medium', finished_at: '2026-10-09T01:00:00Z' } })], { commit: 'abc' });
  assert.deepEqual(Object.keys(raw.profiles), ['low', 'medium']);
  assert.equal(raw.date, '2026-10-09');
  assert.equal(raw.script_commit, 'abc');
  assert.equal(raw.latency_metric, 'items_latency');
  assert.throws(() => buildRaw([summary(), summary({ meta: { profile: 'm', environment: 'stage' } })]), /environment/);
});

test('raw block round-trips through compare.extractRaw', () => {
  const raw = buildRaw([summary()]);
  const back = extractRaw(`## Raw numbers\n\n${rawBlock(raw)}`);
  assert.equal(back.profiles.low.p95_ms, 80.56);
  assert.equal(back.profiles.low.http_4xx, 0);
  assert.equal(back.profiles.low.thresholds_failed, undefined);
  assert.equal(back.endpoint, 'GET /items');
});

test('results table renders n/a for unknowns and FAIL with the failed threshold', () => {
  const md = resultsTable(buildRaw([summary({ meta: { metrics: { latency: 'items_latency', success: 'items_success' } } })]));
  assert.match(md, /\| LOW \| 20 req\/s \| 30s planned \| 600 \| 97\.00% \|/);
  assert.match(md, /\| n\/a \| n\/a \| n\/a \| FAIL \(items_success: rate>0\.99\) \|/);
});

test('profiles are ordered by load (low, medium, high), not by file name', () => {
  const s = (profile) => summary({ meta: { profile } });
  const raw = buildRaw([s('high'), s('custom'), s('low'), s('medium')]);
  assert.deepEqual(Object.keys(raw.profiles), ['low', 'medium', 'high', 'custom']);
});

import { readSummaries, runsTable } from '../plugins/curl2k6/skills/curl2k6/scripts/to-raw.mjs';

test('reads K6_SUMMARY_JSON lines from a k6/CI log (fallback when files were not written)', () => {
  const a = summary();
  const b = summary({ meta: { profile: 'medium' } });
  const log = [
    'time="..." level=info msg="starting"',
    `  items_latency: avg=1`,
    `K6_SUMMARY_JSON ${JSON.stringify(a)}`,
    `2026-10-08T20:00:01Z job-42 | K6_SUMMARY_JSON ${JSON.stringify(b)}`,
    'time="..." level=error msg="failed to handle the end-of-test summary"',
  ].join('\n');
  const got = readSummaries(log, 'ci.log');
  assert.equal(got.length, 2);
  assert.deepEqual(Object.keys(buildRaw(got).profiles), ['low', 'medium']);
  assert.throws(() => readSummaries('just text', 'x.log'), /K6_SUMMARY_JSON/);
});

test('runs table derives UTC start from finish time minus run duration', () => {
  const md = runsTable(buildRaw([summary()]));
  assert.match(md, /\| LOW \| 2026-10-08 19:59:29 \| 2026-10-08 20:00:00 \| \| \|/);
});
