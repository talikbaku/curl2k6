import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../plugins/curl2k6/skills/curl2k6/scripts/request-from.mjs', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'reqfrom-'));
const file = (name, obj) => { const p = join(dir, name); writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); return p; };
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const SECRET = 'eyJhbGciOiJIUzI1NiJ9.super-secret-value';

const har = file('session.har', { log: { entries: [
  { _resourceType: 'script', request: { method: 'GET', url: 'https://shop.example.com/app.js', headers: [] }, response: { status: 200 } },
  { _resourceType: 'fetch', request: { method: 'OPTIONS', url: 'https://api.example.com/v2/items', headers: [] }, response: { status: 204 } },
  { _resourceType: 'fetch', request: { method: 'GET', url: `https://api.example.com/v2/items?limit=50&access_token=${SECRET}`,
    headers: [{ name: ':authority', value: 'api.example.com' }, { name: 'Authorization', value: `Bearer ${SECRET}` }, { name: 'Cookie', value: `sid=${SECRET}` },
      { name: 'Accept', value: 'application/json' }, { name: 'sec-fetch-mode', value: 'cors' }, { name: 'X-Request-Source', value: "it's web" }] }, response: { status: 200 } },
  { _resourceType: 'xhr', request: { method: 'POST', url: 'https://api.example.com/v2/login', headers: [{ name: 'Content-Type', value: 'application/json' }],
    postData: { text: JSON.stringify({ user: 'qa', password: SECRET, meta: { client_secret: SECRET } }) } }, response: { status: 200 } },
] } });

test('HAR --list hides static files and preflights and never prints secrets', () => {
  const r = run(har, '--list');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /4 request\(s\), 2 static\/preflight hidden/);
  assert.doesNotMatch(r.stdout, /app\.js|OPTIONS/);
  assert.match(r.stdout, /\s3\s+GET\s+200\s+https:\/\/api\.example\.com\/v2\/items\?limit=50&access_token=\$ACCESS_TOKEN/);
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  assert.match(run(har, '--list', '--all').stdout, /app\.js/);
});

test('HAR --pick turns secrets into env placeholders and drops browser headers', () => {
  const r = run(har, '--pick', '3');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  assert.match(r.stdout, /-H 'Authorization: Bearer '"\$API_TOKEN"/);
  assert.match(r.stdout, /-H 'Cookie: '"\$COOKIE"/);
  assert.match(r.stdout, /-H 'Accept: application\/json'/);
  assert.match(r.stdout, /-H 'X-Request-Source: it'\\''s web'/);
  assert.doesNotMatch(r.stdout, /authority|sec-fetch/);
  assert.match(r.stderr, /header Authorization → \$API_TOKEN/);
  assert.match(r.stderr, /query parameter "access_token"/);
  assert.match(r.stderr, /dropped browser\/transport headers: :authority, sec-fetch-mode/);
});

test('HAR --pick masks secret JSON body fields, nested too', () => {
  const r = run(har, '--pick', '4', '--format', 'json');
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.method, 'POST');
  assert.deepEqual(JSON.parse(j.body), { user: 'qa', password: '$PASSWORD', meta: { client_secret: '$CLIENT_SECRET' } });
  assert.deepEqual(j.secrets.map((s) => s.env), ['PASSWORD', 'CLIENT_SECRET']);
});

const postman = file('api.postman_collection.json', {
  info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: SECRET }] },
  variable: [{ key: 'baseUrl', value: 'https://api.stage.example.com' }, { key: 'apiToken', value: SECRET }],
  item: [
    { name: 'Items', item: [
      { name: 'List items', request: { method: 'GET', url: { raw: '{{baseUrl}}/v2/items?limit=50' }, header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Old', value: '1', disabled: true }] } },
      { name: 'Create item', request: { method: 'POST', url: '{{baseUrl}}/v2/items', header: [{ key: 'X-Tenant', value: '{{tenant}}' }],
        body: { mode: 'raw', raw: '{"name":"pen","price":2}' } } },
    ] },
    { name: 'Public health', request: { method: 'GET', url: '{{baseUrl}}/health', auth: { type: 'noauth' } } },
    { name: 'Upload', request: { method: 'POST', url: '{{baseUrl}}/files', body: { mode: 'formdata', formdata: [] }, auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Api-Key' }, { key: 'value', value: SECRET }] } } },
  ],
});

test('Postman --list shows folder paths and resolves non-secret variables', () => {
  const r = run(postman);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Postman collection, 4 request\(s\)/);
  assert.match(r.stdout, /1\s+GET\s+https:\/\/api\.stage\.example\.com\/v2\/items\?limit=50\s+— Items \/ List items/);
  assert.ok(!r.stdout.includes(SECRET));
});

test('Postman --pick inherits collection auth as a placeholder; noauth wins; undefined vars become env', () => {
  const a = run(postman, '--pick', '2');
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /^curl -X POST 'https:\/\/api\.stage\.example\.com\/v2\/items' \\\n/);
  assert.match(a.stdout, /-H 'Authorization: Bearer '"\$API_TOKEN"/);
  assert.match(a.stdout, /-H 'X-Tenant: '"\$TENANT"/);
  assert.match(a.stdout, /--data-raw '\{"name":"pen","price":2\}'/);
  assert.match(a.stderr, /\{\{tenant\}\} is not defined/);
  assert.ok(!(a.stdout + a.stderr).includes(SECRET));
  const b = run(postman, '--pick', '3');
  assert.doesNotMatch(b.stdout, /Authorization/);
  const c = run(postman, '--pick', '4');
  assert.match(c.stdout, /-H 'X-Api-Key: '"\$X_API_KEY"/);
  assert.match(c.stderr, /body mode "formdata" is not converted/);
  assert.ok(!(c.stdout + c.stderr).includes(SECRET));
});

test('generated curl is shell-exact: only our placeholders expand', () => {
  const p = file('q.har', { log: { entries: [{ request: { method: 'POST', url: 'https://a.example.com/q?token=abc', headers: [{ name: 'Authorization', value: 'Bearer z' }, { name: 'X-Price', value: '$5 "x" `y` it\'s' }], postData: { text: '{"a":"$HOME","password":"p"}' } } }] } });
  const curl = run(p, '--pick', '1').stdout.replace(/^curl/, "printf '%s\\n'");
  const out = spawnSync('bash', ['-c', curl], { encoding: 'utf8', env: { PATH: process.env.PATH, API_TOKEN: 'T', TOKEN: 'K', PASSWORD: 'P', HOME: '/h' } }).stdout;
  assert.match(out, /token=K\n/);
  assert.match(out, /Authorization: Bearer T\n/);
  assert.match(out, /X-Price: \$5 "x" `y` it's\n/);
  assert.match(out, /\{"a":"\$HOME","password":"P"\}/);
});

test('bad input exits 2 with a clear message; OpenAPI is pointed elsewhere', () => {
  assert.equal(run().status, 2);
  assert.match(run(file('x.json', '{nope')).stderr, /cannot read as JSON/);
  assert.match(run(file('o.json', { openapi: '3.0.0', paths: {} })).stderr, /OpenAPI spec — no script needed/);
  assert.match(run(har, '--pick', '9').stderr, /--pick must be 1\.\.4/);
  assert.match(run(har, '--bogus').stderr, /unknown argument --bogus/);
  assert.equal(run(har, '--pick', '9').status, 2);
});

test('URL secrets: user-info, encoded/+ keys, fragments, repeated keys; everything else keeps its encoding', () => {
  const S = 'TOPSECRET42';
  const urls = [
    `https://u:${S}@a.example.com/p?q=a%20b+c&flag&k=1`,
    `https://${S}@a.example.com/p`,
    `https://a.example.com/p?api+key=${S}&api%20key=${S}&access%5Ftoken=${S}`,
    `https://a.example.com/p?q=1#a?token=${S}`,
    `https://a.example.com/#/route?token=${S}&x=%5B1%5D`,
    `https://a.example.com/p?token=${S}&token=${S}&ids=1&ids=2`,
    `$BASE_URL/p?k=&token=${S}`,
  ];
  const p = file('urls.har', { log: { entries: urls.map((url) => ({ request: { method: 'GET', url, headers: [] } })) } });
  const outs = urls.map((_, i) => run(p, '--pick', String(i + 1), '--format', 'json'));
  for (const o of outs) { assert.equal(o.status, 0, o.stderr); assert.ok(!(o.stdout + o.stderr).includes(S), o.stdout); }
  const u = outs.map((o) => JSON.parse(o.stdout).url);
  assert.equal(u[0], 'https://u:$URL_PASSWORD@a.example.com/p?q=a%20b+c&flag&k=1');
  assert.equal(u[1], 'https://$URL_CREDENTIALS@a.example.com/p');
  assert.equal(u[2], 'https://a.example.com/p?api+key=$API_KEY&api%20key=$API_KEY&access%5Ftoken=$ACCESS_TOKEN');
  assert.equal(u[3], 'https://a.example.com/p?q=1#a?token=$TOKEN');
  assert.equal(u[4], 'https://a.example.com/#/route?token=$TOKEN&x=%5B1%5D');
  assert.equal(u[5], 'https://a.example.com/p?token=$TOKEN&token=$TOKEN&ids=1&ids=2');
  assert.equal(u[6], '$BASE_URL/p?k=&token=$TOKEN');
  assert.equal(outs[5].stderr.match(/secret-looking query parameter "token"/g).length, 1);
});
