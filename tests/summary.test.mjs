import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// summary.js is a k6 module (plain ES module, no k6 imports), so it can be loaded in Node too.
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../plugins/curl2k6/skills/curl2k6/templates/summary.js'), 'utf8');
const { planOf, durationToSeconds, makeHandleSummary } = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);

test('durationToSeconds', () => {
  assert.equal(durationToSeconds('5m'), 300);
  assert.equal(durationToSeconds('1m30s'), 90);
  assert.equal(durationToSeconds('500ms'), 0.5);
  assert.equal(durationToSeconds('1h2m'), 3720);
  assert.equal(durationToSeconds(45), 45);
  assert.equal(durationToSeconds('nonsense'), null);
  assert.equal(durationToSeconds(undefined), null);
});

test('planOf: ramping-arrival-rate uses peak stage target and summed stage durations', () => {
  const plan = planOf({ scenarios: { load: { executor: 'ramping-arrival-rate', startRate: 5, timeUnit: '1s', stages: [{ target: 50, duration: '4m' }, { target: 50, duration: '1m' }, { target: 0, duration: '30s' }] } } });
  assert.deepEqual(plan, { scenario: 'load', executor: 'ramping-arrival-rate', target_rate_rps: 50, peak_vus: null, planned_duration_s: 330 });
});

test('planOf: timeUnit is normalised to requests per second', () => {
  assert.equal(planOf({ scenarios: { a: { executor: 'constant-arrival-rate', rate: 600, timeUnit: '1m', duration: '2m' } } }).target_rate_rps, 10);
});

test('planOf: VU executors and classic stages', () => {
  assert.equal(planOf({ scenarios: { a: { executor: 'ramping-vus', stages: [{ target: 30, duration: '1m' }] } } }).peak_vus, 30);
  assert.equal(planOf({ scenarios: { a: { executor: 'constant-vus', vus: 7, duration: '20s' } } }).planned_duration_s, 20);
  assert.deepEqual(planOf({ stages: [{ target: 10, duration: '1m' }, { target: 0, duration: '10s' }] }).peak_vus, 10);
});

test('handleSummary writes stdout line and per-profile file into out_dir', () => {
  const h = makeHandleSummary({ test: 't', profile: 'LOW', out_dir: 'results/' });
  const out = h({ metrics: { x: { type: 'rate', values: { rate: 0.5, passes: 1, fails: 1 }, thresholds: { 'rate>0.9': { ok: false } } } }, state: { testRunDurationMs: 1000 } });
  assert.deepEqual(Object.keys(out).sort(), ['results/summary-low.json', 'results/summary.json', 'stdout']);
  assert.match(out.stdout, /x: rate=50% true=1 false=1 \[FAIL rate>0.9\]/);
  assert.match(out.stdout, /^K6_SUMMARY_JSON \{/m);
});
