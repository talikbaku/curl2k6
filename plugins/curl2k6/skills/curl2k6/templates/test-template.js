// Generated with the curl2k6 skill (Claude Code). To re-run, compare with the previous report or
// change profiles, ask Claude to use curl2k6 — reports and comparisons come from its scripts.
//
// Run:  mkdir -p <out> && k6 run -e LOAD_PROFILE=low -e TARGET_ENV=<env> -e GIT_SHA=$(git rev-parse --short HEAD) \
//         -e OUT_DIR=<out> [-e BASE_URL=...] [-e API_TOKEN=...] <name>.js | tee <out>/k6-low.log
// Secrets come from the environment (-e / CI variables) — never hardcode a token from the curl.
//
// (Skeleton notes for the skill — delete this block in the generated test: replace every <PLACEHOLDER>,
//  keep the structure; if the repo already has load tests, mirror their conventions instead.)

import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
// import { SharedArray } from 'k6/data';           // only if the endpoint needs per-user IDs/credentials
import { makeHandleSummary, planOf } from './summary.js';

const TEST = '<test-name>';                          // e.g. orders-api
const ENDPOINT = '<METHOD> <path>';                  // e.g. GET /v2/orders — used to match previous reports
const BASE_URL = __ENV.BASE_URL || '<https://base-url-from-the-curl>';
const PROFILE = (__ENV.LOAD_PROFILE || 'low').toLowerCase();
const BODY = null; // request body from the curl, e.g. JSON.stringify({ ... }) — null for GET

// Agreed load profiles. Size them to what the service can plausibly take — ask, don't guess big.
const PROFILES = {
  low:    { stages: [{ target: 5,  duration: '4m' }, { target: 5,  duration: '1m' }, { target: 0, duration: '30s' }] },
  medium: { stages: [{ target: 20, duration: '5m' }, { target: 20, duration: '1m' }, { target: 0, duration: '30s' }] },
  high:   { stages: [{ target: 50, duration: '6m' }, { target: 50, duration: '1m' }, { target: 0, duration: '30s' }] },
};
if (!PROFILES[PROFILE]) throw new Error(`unknown LOAD_PROFILE "${PROFILE}" — expected one of ${Object.keys(PROFILES)}`);

export const options = {
  scenarios: {
    [PROFILE]: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 10,
      maxVUs: 200,
      stages: PROFILES[PROFILE].stages,
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'], // k6 has no p(99) by default
  thresholds: {
    '<prefix>_success': ['rate>0.99'],
    '<prefix>_latency_2xx': ['p(95)<500'],
  },
};

// Per-endpoint metrics: all requests vs successful (2xx) only, timeouts separate from 4xx/5xx.
const latency = new Trend('<prefix>_latency', true);
const latency2xx = new Trend('<prefix>_latency_2xx', true);
const success = new Rate('<prefix>_success');
const timeouts = new Counter('<prefix>_timeouts');
const http4xx = new Counter('<prefix>_4xx');
const http5xx = new Counter('<prefix>_5xx');

// const pool = new SharedArray('ids', () => JSON.parse(open('./<pool>.json')));

export default function () {
  // const id = pool[Math.floor(Math.random() * pool.length)];
  const params = {
    headers: {
      // Authorization: `Bearer ${__ENV.API_TOKEN}`,
      // <other headers from the curl, minus secrets>
    },
    timeout: '10s',
    tags: { endpoint: ENDPOINT },
  };
  const res = http.request('<METHOD>', `${BASE_URL}<path>`, BODY, params);

  latency.add(res.timings.duration);
  const ok = res.status >= 200 && res.status < 300;
  success.add(ok);
  if (ok) latency2xx.add(res.timings.duration);
  if (res.error_code === 1050) timeouts.add(1); // k6 request timeout
  else if (res.status >= 400 && res.status < 500) http4xx.add(1);
  else if (res.status >= 500) http5xx.add(1);
  check(res, { '2xx': () => ok });
}

export const handleSummary = makeHandleSummary({
  test: TEST,
  environment: __ENV.TARGET_ENV || '<environment>',
  endpoint: ENDPOINT,
  profile: PROFILE,
  script_commit: __ENV.GIT_SHA || null,
  plan: planOf(options),
  out_dir: __ENV.OUT_DIR || null,
  metrics: {
    latency: '<prefix>_latency', latency_2xx: '<prefix>_latency_2xx', success: '<prefix>_success',
    timeouts: '<prefix>_timeouts', http_4xx: '<prefix>_4xx', http_5xx: '<prefix>_5xx',
  },
});
