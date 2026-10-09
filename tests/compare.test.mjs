import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareProfile, compareRuns, comparability, extractRaw, mergeLatest, records, toMarkdown,
  normTest, NoRawBlockError,
} from '../plugins/curl2k6/skills/curl2k6/scripts/compare.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../plugins/curl2k6/skills/curl2k6/scripts/compare.mjs');

const base = {
  test: 'orders-api', date: '2026-10-01', environment: 'stage', endpoint: 'GET /orders',
  script_commit: 'aaa111', latency_metric: 'orders_latency', profile: 'low',
  executor: 'ramping-arrival-rate', target_rate_rps: 50, peak_vus: null, planned_duration_s: 300,
  requests: 10000, success_rate: 0.995, p50_ms: 40, p95_ms: 100, p99_ms: 200, max_ms: 900,
  timeouts: 5, http_4xx: 0, http_5xx: 45,
};
const row = (res, metric) => res.rows.find((r) => r.metric === metric);

test('p95 thresholds: +19% ok, exactly +20% ok, +25% regression', () => {
  assert.equal(row(compareProfile(base, { ...base, p95_ms: 119 }), 'p95 ms').flag, 'ok');
  assert.equal(row(compareProfile(base, { ...base, p95_ms: 120 }), 'p95 ms').flag, 'ok');
  assert.equal(row(compareProfile(base, { ...base, p95_ms: 125 }), 'p95 ms').flag, 'regression');
});

test('exactly +20% is not flagged even when floating point says 20.000000000000004', () => {
  // (0.84 - 0.7) / 0.7 * 100 === 20.000000000000004 in IEEE-754
  assert.ok((0.84 - 0.7) / 0.7 * 100 > 20);
  const r = compareProfile({ ...base, p99_ms: 0.7 }, { ...base, p99_ms: 0.84 });
  assert.equal(row(r, 'p99 ms').flag, 'ok');
});

test('success rate: -0.5 pp ok, exactly -1 pp ok, -1.5 pp regression', () => {
  assert.equal(row(compareProfile(base, { ...base, success_rate: 0.99 }), 'success rate').flag, 'ok');
  // 0.985 - 0.995 = -0.010000000000000009 -> must still count as exactly 1 pp
  assert.equal(row(compareProfile(base, { ...base, success_rate: 0.985 }), 'success rate').flag, 'ok');
  assert.equal(row(compareProfile(base, { ...base, success_rate: 0.98 }), 'success rate').flag, 'regression');
  // improvement is never a regression
  assert.equal(row(compareProfile({ ...base, success_rate: 0.9 }, base), 'success rate').flag, 'ok');
});

test('timeout share: +0.05 pp ok, +0.2 pp regression, shown as count and share', () => {
  const ok = row(compareProfile(base, { ...base, timeouts: 10 }), 'timeouts'); // 0.05% -> 0.10%
  assert.equal(ok.flag, 'ok');
  const bad = row(compareProfile(base, { ...base, timeouts: 25 }), 'timeouts'); // 0.05% -> 0.25%
  assert.equal(bad.flag, 'regression');
  assert.equal(bad.previous, 5);
  assert.ok(Math.abs(bad.current_share_pct - 0.25) < 1e-9);
});

test('missing values are n/a with no flag — never treated as 0', () => {
  const r = compareProfile({ ...base, p95_ms: null, timeouts: undefined }, { ...base, p95_ms: 500 });
  assert.equal(row(r, 'p95 ms').flag, null);
  assert.equal(row(r, 'p95 ms').delta, null);
  assert.equal(row(r, 'timeouts').flag, null);
  assert.equal(row(r, 'timeouts').previous, null);
  assert.deepEqual(r.regressions, []);
});

test('different environment -> not like-for-like, flags labelled, no confirmed regression', () => {
  const curr = { ...base, environment: 'production', p95_ms: 400 };
  const r = compareProfile(base, curr);
  assert.equal(r.comparable.status, 'not-like-for-like');
  assert.deepEqual(r.regressions, ['p95 ms']);
  assert.deepEqual(r.confirmed, []);
  const md = toMarkdown(compareRuns([{ source: 'prev.md', raw: { ...base, profiles: { low: base } } }], { ...curr, profiles: { low: curr } }));
  assert.match(md, /not like-for-like/);
  assert.match(md, /⚠ regression \(not like-for-like\)/);
  assert.match(md, /No regressions on comparable profiles/);
});

test('different load or planned duration -> not like-for-like', () => {
  assert.equal(comparability(base, { ...base, target_rate_rps: 80 }).status, 'not-like-for-like');
  assert.equal(comparability(base, { ...base, planned_duration_s: 360 }).status, 'not-like-for-like');
});

test('core field unknown on one side -> cannot be confirmed', () => {
  const c = comparability({ ...base, planned_duration_s: null }, base);
  assert.equal(c.status, 'unconfirmed');
  assert.match(c.unknown[0], /planned duration/);
  assert.equal(comparability({ ...base, target_rate_rps: null, peak_vus: 20 }, base).status, 'unconfirmed');
});

test('VU-based runs compare on peak VUs', () => {
  const v = { ...base, executor: 'ramping-vus', target_rate_rps: null, peak_vus: 30 };
  assert.equal(comparability(v, { ...v }).status, 'yes');
  assert.equal(comparability(v, { ...v, peak_vus: 60 }).status, 'not-like-for-like');
});

test('secondary differences (commit, executor, missing fields in old reports) stay comparable with notes', () => {
  const old = { ...base, script_commit: undefined, executor: undefined, latency_metric: undefined };
  const c = comparability(old, { ...base, script_commit: 'bbb222' });
  assert.equal(c.status, 'yes');
  assert.ok(c.notes.some((n) => n.startsWith('script commit unknown')));
  assert.equal(comparability(base, { ...base, script_commit: 'bbb222' }).notes[0], 'script commit differs: aaa111 → bbb222');
});

test('test names like orders-api-test.js and orders-api are the same test', () => {
  assert.equal(normTest('orders-api-test.js'), 'orders-api');
  assert.equal(normTest('Orders-API_load_test'), 'orders-api');
  assert.equal(comparability({ ...base, test: 'orders-api-test.js' }, base).notes.length, 0);
});

test('endpoint and environment comparison ignores case and spacing', () => {
  assert.equal(comparability({ ...base, endpoint: 'get  /orders', environment: 'Stage' }, base).status, 'yes');
});

test('one previous file per profile: the most recent one wins for its profile only', () => {
  const r1 = { ...base, date: '2026-09-01', profiles: { low: { p95_ms: 1 }, medium: { p95_ms: 2 } } };
  const r2 = { ...base, date: '2026-09-20', profiles: { medium: { p95_ms: 3 } } };
  const m = mergeLatest([records(r1, 'a.md'), records(r2, 'b.md')]);
  assert.equal(m.get('low').source, 'a.md');
  assert.equal(m.get('medium').source, 'b.md');
  assert.equal(m.get('medium').p95_ms, 3);
});

test('profile with no previous data is reported as baseline', () => {
  const res = compareRuns([{ source: 'p', raw: { ...base, profiles: { low: base } } }], { ...base, profiles: { low: base, high: base } });
  assert.equal(res.profiles.find((p) => p.profile === 'high').baseline, true);
  assert.match(toMarkdown(res), /HIGH\*\*: no previous data/);
});

test('no previous report at all -> baseline text', () => {
  assert.equal(toMarkdown(compareRuns([], { ...base, profiles: { low: base } })), 'Baseline run — no previous report to compare with.\n');
});

test('caveat for shared environments, not for local or --dedicated', () => {
  const run = (env, dedicated) => compareRuns([{ source: 'p', raw: { ...base, environment: env, profiles: { low: base } } }], { ...base, environment: env, profiles: { low: base } }, { dedicated }).caveat;
  assert.equal(run('stage'), true);
  assert.equal(run('production'), true);
  assert.equal(run('local'), false);
  assert.equal(run('stage', true), false);
});

test('custom thresholds', () => {
  const r = compareProfile(base, { ...base, p95_ms: 115 }, { p95: 10, p99: 20, successPp: 1, timeoutPp: 0.1 });
  assert.equal(row(r, 'p95 ms').flag, 'regression');
});

test('extractRaw reads the Raw numbers block from a markdown report', () => {
  const md = '# x\n\n```json\n{"decoy": true}\n```\n\n## Raw numbers (for future comparisons)\n\ntext\n\n```json\n{"test":"t","profiles":{"low":{"p95_ms":1}}}\n```\n';
  assert.equal(extractRaw(md).test, 't');
  assert.throws(() => extractRaw('# old report\n| a | b |\n'), NoRawBlockError);
});

test('CLI: exit 1 with --fail-on-regression, exit 2 on report without raw block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'curl2k6-'));
  const prev = join(dir, 'prev.json');
  const curr = join(dir, 'curr.json');
  const old = join(dir, 'old.md');
  writeFileSync(prev, JSON.stringify({ ...base, profiles: { low: base } }));
  writeFileSync(curr, JSON.stringify({ ...base, profiles: { low: { ...base, p95_ms: 150 } } }));
  writeFileSync(old, '# old\n| Profile | p95 |\n|---|---|\n| LOW | 100 |\n');
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const ok = run('--prev', prev, '--curr', curr);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /\| LOW \| p95 ms \| 100 \| 150 \| \+50\.0% \| ⚠ regression \|/);
  assert.equal(run('--prev', prev, '--curr', curr, '--fail-on-regression').status, 1);
  const bad = run('--prev', old, '--curr', curr);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /no "Raw numbers" section/);
});

import { toText } from '../plugins/curl2k6/skills/curl2k6/scripts/compare.mjs';

test('text format: aligned, colour only on request, labels unconfirmed flags', () => {
  const prev = [{ source: 'prev.md', raw: { ...base, profiles: { low: base } } }];
  const plain = toText(compareRuns(prev, { ...base, profiles: { low: { ...base, p95_ms: 150 } } }));
  assert.doesNotMatch(plain, /\x1b\[/);
  assert.match(plain, /LOW +p95 ms +100 +150 +\+50\.0% +⚠ regression/);
  assert.match(plain, /REGRESSION: LOW p95 ms/);
  const colored = toText(compareRuns(prev, { ...base, profiles: { low: { ...base, p95_ms: 150 } } }), { color: true });
  assert.match(colored, /\x1b\[1;31m⚠ regression/);
  const other = toText(compareRuns(prev, { ...base, environment: 'prod', profiles: { low: { ...base, environment: 'prod', p95_ms: 150 } } }));
  assert.match(other, /NOT like-for-like/);
  assert.match(other, /⚠ regression \(not like-for-like\)/);
  assert.match(other, /No regressions on comparable profiles/);
});


// ---- regressions found by the independent review ----
import { validateRaw, BadInputError } from '../plugins/curl2k6/skills/curl2k6/scripts/compare.mjs';

test('review: non-numeric values are rejected (exit 2), never a silent ✓', () => {
  for (const [f, v] of [['p95_ms', '1,234'], ['success_rate', '99.50%'], ['timeouts', 'n/a'], ['p99_ms', NaN]]) {
    assert.throws(() => validateRaw({ profiles: { low: { ...base, [f]: v } } }, 'x'), BadInputError, `${f}=${v}`);
  }
  assert.throws(() => validateRaw({ profiles: { low: { ...base, success_rate: 99.5 } } }, 'x'), /fraction 0\.\.1/);
  assert.throws(() => validateRaw({ profiles: { low: { ...base, requests: -1 } } }, 'x'), />= 0/);
});

test('review: wrong-shaped input (k6 summary.json, {}, profiles:null) is an error, not "Baseline run"', () => {
  for (const raw of [{}, { profiles: null }, { profiles: {} }, { metrics: {}, meta: {} }, { profiles: { low: 5 } }]) {
    assert.throws(() => validateRaw(raw, 'x'), BadInputError);
  }
  const dir = mkdtempSync(join(tmpdir(), 'curl2k6-'));
  const k6sum = join(dir, 'summary-low.json');
  const curr = join(dir, 'curr.json');
  writeFileSync(k6sum, JSON.stringify({ meta: { profile: 'low' }, metrics: {} }));
  writeFileSync(curr, JSON.stringify({ ...base, profiles: { low: base } }));
  const r = spawnSync(process.execPath, [SCRIPT, '--prev', curr, '--curr', k6sum, '--fail-on-regression'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a curl2k6 raw file/);
});

test('review: Raw numbers block is taken from its own section only; "for future comparisons" wins', () => {
  const noBlock = '## Raw numbers\n\n(none)\n\n## Appendix\n\n```json\n{"profiles":{"low":{"p95_ms":1}}}\n```\n';
  assert.throws(() => extractRaw(noBlock), NoRawBlockError);
  const two = '### Raw numbers (previous run)\n```json\n{"profiles":{"low":{"p95_ms":29.22}}}\n```\n' +
    '## Raw numbers (for future comparisons)\n```json\n{"profiles":{"low":{"p95_ms":42.11}}}\n```\n';
  assert.equal(extractRaw(two).profiles.low.p95_ms, 42.11);
  const fencedHash = '## Raw numbers\n```json\n{"profiles":{"low":{"p95_ms":7}}}\n```\n## Appendix\n```bash\n# Raw numbers in a comment\n```\n';
  assert.equal(extractRaw(fencedHash).profiles.low.p95_ms, 7);
});

test('review: most recent previous run wins by finished_at, then date (not by string order)', () => {
  const a = records({ ...base, date: '2026-10-08', profiles: { low: { finished_at: '2026-10-08T21:04:00Z', p95_ms: 2 } } }, 'newer.md');
  const b = records({ ...base, date: '2026-10-08', profiles: { low: { finished_at: '2026-10-08T21:03:00Z', p95_ms: 1 } } }, 'older.md');
  assert.equal(mergeLatest([a, b]).get('low').source, 'newer.md');
  const sep = records({ ...base, date: '2026-9-30', profiles: { low: {} } }, 'sep30.md');
  const oct = records({ ...base, date: '2026-10-01', profiles: { low: {} } }, 'oct01.md');
  assert.equal(mergeLatest([oct, sep]).get('low').source, 'oct01.md');
});

test('review: iteration-based load and blank strings are part of comparability', () => {
  const it = { ...base, target_rate_rps: null, peak_vus: 10, executor: 'shared-iterations', iterations: 10 };
  assert.equal(comparability(it, { ...it, iterations: 100000 }).status, 'not-like-for-like');
  assert.equal(comparability({ ...base, environment: '' }, { ...base, environment: ' ' }).status, 'unconfirmed');
});

test('review: previous reports with no common profile are named, not "no previous report"', () => {
  const res = compareRuns([{ source: 'prev.md', raw: { ...base, profiles: { high: base } } }], { ...base, profiles: { low: base } });
  const md = toMarkdown(res);
  assert.match(md, /prev\.md have no data for the profiles of this run \(LOW; previous profiles: HIGH\)/);
});

test('review: a delta just over the threshold is printed with 2 decimals', () => {
  const md = toMarkdown(compareRuns([{ source: 'p', raw: { ...base, profiles: { low: base } } }], { ...base, profiles: { low: { ...base, p95_ms: 120.04 } } }));
  assert.match(md, /\+20\.04% \| ⚠ regression/);
});

test('review: several --prev files must each have their own flag (helpful error)', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--prev', 'a.md', 'b.md', '--curr', 'c.json'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /repeat --prev/);
});
