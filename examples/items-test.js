// Example of what the curl2k6 skill generates from:
//   curl -H 'Accept: application/json' 'http://127.0.0.1:8099/items?limit=20'
// It is templates/test-template.js filled in, with short demo profiles (15 s each) so the
// demo finishes in about two minutes. Real profiles are minutes long — see the template.
//
// Run: k6 run -e LOAD_PROFILE=low -e TARGET_ENV=local -e OUT_DIR=out examples/items-test.js

import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
// In a generated test summary.js is copied next to the test; the demo imports the template directly.
import { makeHandleSummary, planOf } from '../plugins/curl2k6/skills/curl2k6/templates/summary.js';

const TEST = 'items-api';
const ENDPOINT = 'GET /items';
const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8099';
const PROFILE = (__ENV.LOAD_PROFILE || 'low').toLowerCase();

const PROFILES = {
  low:    { stages: [{ target: 20,  duration: '5s' }, { target: 20,  duration: '10s' }] },
  medium: { stages: [{ target: 60,  duration: '5s' }, { target: 60,  duration: '10s' }] },
  high:   { stages: [{ target: 150, duration: '5s' }, { target: 150, duration: '10s' }] },
};
if (!PROFILES[PROFILE]) throw new Error(`unknown LOAD_PROFILE "${PROFILE}" — expected one of ${Object.keys(PROFILES)}`);

export const options = {
  scenarios: {
    [PROFILE]: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 300,
      stages: PROFILES[PROFILE].stages,
    },
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    items_success: ['rate>0.99'],
    items_latency_2xx: ['p(95)<300'],
  },
};

const latency = new Trend('items_latency', true);
const latency2xx = new Trend('items_latency_2xx', true);
const success = new Rate('items_success');
const timeouts = new Counter('items_timeouts');
const http4xx = new Counter('items_4xx');
const http5xx = new Counter('items_5xx');

export default function () {
  const params = { headers: { Accept: 'application/json' }, timeout: '2s', tags: { endpoint: ENDPOINT } };
  const res = http.get(`${BASE_URL}/items?limit=20`, params);

  latency.add(res.timings.duration);
  const ok = res.status >= 200 && res.status < 300;
  success.add(ok);
  if (ok) latency2xx.add(res.timings.duration);
  if (res.error_code === 1050) timeouts.add(1);
  else if (res.status >= 400 && res.status < 500) http4xx.add(1);
  else if (res.status >= 500) http5xx.add(1);
  check(res, { '2xx': () => ok });
}

export const handleSummary = makeHandleSummary({
  test: TEST,
  environment: __ENV.TARGET_ENV || 'local',
  endpoint: ENDPOINT,
  profile: PROFILE,
  script_commit: __ENV.GIT_SHA || null,
  plan: planOf(options),
  out_dir: __ENV.OUT_DIR || null,
  metrics: {
    latency: 'items_latency', latency_2xx: 'items_latency_2xx', success: 'items_success',
    timeouts: 'items_timeouts', http_4xx: 'items_4xx', http_5xx: 'items_5xx',
  },
});
