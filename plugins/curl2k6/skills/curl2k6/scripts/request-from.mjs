#!/usr/bin/env node
// request-from.mjs — pick one request out of a HAR file or a Postman collection (v2.0/v2.1)
// and print it as a curl the curl2k6 skill can build a test from. Zero dependencies.
//
//   node request-from.mjs <file.har|collection.json> --list [--all]
//   node request-from.mjs <file> --pick <N> [--format curl|json]
//
// Secrets never reach the output: Authorization / Cookie / API-key style headers, secret-looking
// query parameters and JSON body fields are replaced with $ENV_VAR placeholders; stderr says which
// env vars the test needs. Exit codes: 0 ok, 2 bad input or arguments.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

class BadInput extends Error {}

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token)$|token|secret|session|password|api[-_]?key/i;
const SECRET_FIELD = /pass(word)?|secret|token|api[-_ ]?key|client[-_]?secret|session|signature|^sig$|^code$|^auth/i;
const DROP_HEADER = /^(:.*|host|content-length|connection|accept-encoding|priority|upgrade-insecure-requests|pragma|cache-control|te|sec-.*)$/i;
const STATIC_EXT = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|eot|map|mp4|webm|mp3)(\?|$)/i;
const STATIC_TYPE = new Set(['image', 'stylesheet', 'script', 'font', 'media', 'manifest', 'other', 'ping']);

const envName = (s) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase() || 'SECRET';

// ---------- loading ----------
function load(file) {
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { throw new BadInput(`${file}: cannot read as JSON (${e.code || e.message})`); }
  if (doc?.log?.entries) return { kind: 'har', requests: fromHar(doc) };
  if (Array.isArray(doc?.item) || /postman/i.test(doc?.info?.schema || '')) return { kind: 'postman', requests: fromPostman(doc) };
  if (doc?.openapi || doc?.swagger) throw new BadInput(`${file} is an OpenAPI spec — no script needed: read the spec, list its operations and build the request from servers + path + examples`);
  throw new BadInput(`${file}: not a HAR file (log.entries) or a Postman collection (item[])`);
}

function fromHar(doc) {
  return doc.log.entries.map((e) => {
    const r = e.request || {};
    const url = r.url || '';
    const type = (e._resourceType || '').toLowerCase();
    return {
      name: '', method: (r.method || 'GET').toUpperCase(), url,
      headers: (r.headers || []).map((h) => [h.name, h.value]),
      body: r.postData?.text ?? (r.postData?.params ? r.postData.params.map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value ?? '')}`).join('&') : null),
      status: e.response?.status ?? null,
      noise: !/^https?:/i.test(url) || STATIC_EXT.test(url) || STATIC_TYPE.has(type) || r.method === 'OPTIONS',
      auth: null, warnings: [], envs: [],
    };
  });
}

function fromPostman(doc) {
  const vars = Object.fromEntries((doc.variable || []).filter((v) => v && v.key).map((v) => [v.key, v.value]));
  const out = [];
  const walk = (items, path, auth) => {
    for (const it of items || []) {
      const a = it.auth || auth;
      if (Array.isArray(it.item)) { walk(it.item, [...path, it.name], a); continue; }
      const r = typeof it.request === 'string' ? { url: it.request } : (it.request || {});
      const warnings = []; const envs = [];
      const sub = (s) => String(s ?? '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, k) => {
        if (k in vars && !SECRET_FIELD.test(k) && vars[k] !== '') return String(vars[k]);
        warnings.push(`variable {{${k}}} ${k in vars ? 'looks secret' : 'is not defined in the collection'} — set it as $${envName(k)}`);
        envs.push(envName(k)); return `$${envName(k)}`;
      });
      let url = typeof r.url === 'string' ? r.url : (r.url?.raw ?? '');
      if (!url && r.url?.host) url = `${(r.url.protocol || 'https')}://${[].concat(r.url.host).join('.')}/${[].concat(r.url.path || []).join('/')}`;
      let body = null;
      const b = r.body || {};
      if (b.mode === 'raw') body = sub(b.raw);
      else if (b.mode === 'urlencoded') body = (b.urlencoded || []).filter((p) => !p.disabled).map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(sub(p.value))}`).join('&');
      else if (b.mode === 'graphql') body = JSON.stringify({ query: b.graphql?.query || '', variables: safeJson(sub(b.graphql?.variables || '{}')) });
      else if (b.mode) warnings.push(`body mode "${b.mode}" is not converted — add the body to the test by hand`);
      out.push({
        name: [...path, it.name].filter(Boolean).join(' / '),
        method: (r.method || 'GET').toUpperCase(), url: sub(url),
        headers: (r.header || []).filter((h) => !h.disabled).map((h) => [h.key, sub(h.value)]),
        body, status: null, noise: false, auth: r.auth || a || null, warnings, envs,
      });
    }
  };
  walk(doc.item, [], doc.auth || null);
  return out;
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return s; } };

// ---------- redaction ----------
function redact(req) {
  const secrets = []; const notes = [...req.warnings];
  const placeholder = (what, env) => { if (!secrets.some((s) => s.env === env)) secrets.push({ what, env }); return `$${env}`; };
  const headers = [];
  const dropped = [];
  for (const [k, v] of req.headers) {
    if (DROP_HEADER.test(k)) { dropped.push(k.toLowerCase()); continue; }
    if (/^authorization$/i.test(k)) {
      const scheme = /^(bearer|basic|token|apikey|digest)\s+/i.exec(v || '');
      headers.push([k, `${scheme ? scheme[0] : ''}${placeholder(`header ${k}`, scheme && /basic/i.test(scheme[1]) ? 'BASIC_AUTH' : 'API_TOKEN')}`]);
    } else if (/^cookie$/i.test(k)) headers.push([k, placeholder('header Cookie', 'COOKIE')]);
    else if (SECRET_HEADER.test(k) && !/^\$[A-Z0-9_]+$/.test(v)) headers.push([k, placeholder(`header ${k}`, envName(k))]);
    else headers.push([k, v]);
  }
  // Postman auth blocks → headers (values never copied)
  const a = req.auth;
  if (a && a.type && a.type !== 'noauth' && !headers.some(([k]) => /^authorization$/i.test(k))) {
    if (a.type === 'bearer') headers.push(['Authorization', `Bearer ${placeholder('Postman bearer auth', 'API_TOKEN')}`]);
    else if (a.type === 'basic') headers.push(['Authorization', `Basic ${placeholder('Postman basic auth (base64 user:password)', 'BASIC_AUTH')}`]);
    else if (a.type === 'apikey') {
      const kv = Object.fromEntries((a.apikey || []).map((x) => [x.key, x.value]));
      const name = kv.key || 'X-API-Key';
      if ((kv.in || 'header') === 'header') headers.push([name, placeholder(`Postman API key header ${name}`, envName(name))]);
      else notes.push(`API key "${name}" goes in the query string — prefer a header if the API allows (query strings end up in k6 logs)`);
    } else notes.push(`Postman auth type "${a.type}" is not converted — add it to the test by hand`);
  }
  // URL: credentials in user-info, then query parameters in the query string and in a #/route?… fragment.
  // Parsed as text (no URL object), so everything else keeps its original encoding.
  const scanParams = (query) => query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    let k = pair.slice(0, eq).replace(/\+/g, ' ');
    try { k = decodeURIComponent(k); } catch { notes.push(`query parameter "${pair.slice(0, eq)}" has broken %-encoding — check it by hand`); }
    const v = pair.slice(eq + 1);
    if (!SECRET_FIELD.test(k) || /^\$[A-Z0-9_]+$/.test(v)) return pair;
    notes.push(`secret-looking query parameter "${k}" — it will appear in k6 logs; move it to a header if the API allows`);
    return `${pair.slice(0, eq)}=${placeholder(`query ?${k}=`, envName(k))}`;
  }).join('&');
  let url = req.url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]*)@/i, (m, scheme, info) => {
    const c = info.indexOf(':');
    notes.push('credentials in the URL (user:password@host) — prefer an Authorization header');
    return c >= 0 ? `${scheme}${info.slice(0, c)}:${placeholder('password in the URL', 'URL_PASSWORD')}@` : `${scheme}${placeholder('credentials in the URL', 'URL_CREDENTIALS')}@`;
  });
  const hi = url.indexOf('#');
  let main = hi < 0 ? url : url.slice(0, hi), frag = hi < 0 ? '' : url.slice(hi);
  const qi = main.indexOf('?');
  if (qi >= 0) main = `${main.slice(0, qi)}?${scanParams(main.slice(qi + 1))}`;
  const fq = frag.indexOf('?');
  if (fq >= 0) frag = `${frag.slice(0, fq)}?${scanParams(frag.slice(fq + 1))}`;
  url = main + frag;
  // JSON body fields
  let body = req.body;
  if (body) {
    const j = safeJson(body);
    if (j && typeof j === 'object') {
      const walk = (o) => { for (const k of Object.keys(o)) {
        if (o[k] && typeof o[k] === 'object') walk(o[k]);
        else if (SECRET_FIELD.test(k) && typeof o[k] === 'string' && !/^\$[A-Z0-9_]+$/.test(o[k])) o[k] = placeholder(`body field "${k}"`, envName(k));
      } };
      walk(j); body = JSON.stringify(j);
    } else if (/(^|&)(password|pass|secret|token|client_secret)=/i.test(body)) {
      body = body.replace(/(^|&)(password|pass|secret|token|client_secret)=([^&]*)/gi, (m, p, k) => `${p}${k}=${placeholder(`form field "${k}"`, envName(k))}`);
    }
  }
  if (dropped.length) notes.push(`dropped browser/transport headers: ${[...new Set(dropped)].join(', ')}`);
  const envs = [...new Set([...secrets.map((x) => x.env), ...req.envs])];
  return { method: req.method, url, headers, body, secrets, envs, notes: [...new Set(notes)] };
}

// ---------- output ----------
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// single-quote everything except the $PLACEHOLDERS this script introduced, so a literal "$5" or
// "$HOME" in a header or body stays literal while "$API_TOKEN" expands from the environment
function quoter(envs) {
  if (!envs.length) return sq;
  const re = new RegExp(`\\$(${envs.join('|')})(?![A-Za-z0-9_])`, 'g');
  return (s) => {
    const out = []; let last = 0; s = String(s);
    for (const m of s.matchAll(re)) { if (m.index > last) out.push(sq(s.slice(last, m.index))); out.push(`"$${m[1]}"`); last = m.index + m[0].length; }
    if (last < s.length || !out.length) out.push(sq(s.slice(last)));
    return out.join('');
  };
}
function toCurl(r) {
  const q = quoter(r.envs);
  const lines = [`curl ${r.method !== 'GET' || r.body ? `-X ${r.method} ` : ''}${q(r.url)}`];
  for (const [k, v] of r.headers) lines.push(`-H ${q(`${k}: ${v}`)}`);
  if (r.body) lines.push(`--data-raw ${q(r.body)}`);
  return lines.join(' \\\n  ');
}
function shortUrl(u, n = 90) { return u.length > n ? u.slice(0, n - 1) + '…' : u; }

function main(argv) {
  const args = { file: null, list: false, all: false, pick: null, format: 'curl' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--all') args.all = true;
    else if (a === '--pick') args.pick = Number(argv[++i]);
    else if (a === '--format') args.format = argv[++i];
    else if (a === '-h' || a === '--help') { console.log('usage: request-from.mjs <file.har|collection.json> --list [--all] | --pick <N> [--format curl|json]'); return 0; }
    else if (a.startsWith('-')) throw new BadInput(`unknown argument ${a}`);
    else if (!args.file) args.file = a;
    else throw new BadInput(`unexpected argument ${a}`);
  }
  if (!args.file) throw new BadInput('missing input file (a .har or a Postman collection .json)');
  if (!args.list && args.pick == null) args.list = true;
  if (!['curl', 'json'].includes(args.format)) throw new BadInput('--format must be curl or json');
  const { kind, requests } = load(args.file);
  if (args.list) {
    const shown = requests.map((r, i) => ({ r, i: i + 1 })).filter(({ r }) => args.all || !r.noise);
    console.log(`${basename(args.file)}: ${kind === 'har' ? 'HAR' : 'Postman collection'}, ${requests.length} request(s)${kind === 'har' && !args.all ? `, ${requests.length - shown.length} static/preflight hidden (--all shows them)` : ''}`);
    for (const { r, i } of shown) {
      const red = redact(r);
      console.log(`${String(i).padStart(4)}  ${r.method.padEnd(6)} ${r.status != null ? String(r.status).padEnd(4) : ''}${shortUrl(red.url)}${r.name ? `   — ${r.name}` : ''}`);
    }
    console.log(`\nPick one: node ${basename(process.argv[1] || 'request-from.mjs')} ${basename(args.file)} --pick <N>`);
    return 0;
  }
  if (!Number.isInteger(args.pick) || args.pick < 1 || args.pick > requests.length) throw new BadInput(`--pick must be 1..${requests.length}`);
  const src = requests[args.pick - 1];
  const r = redact(src);
  if (args.format === 'json') console.log(JSON.stringify({ source: { file: basename(args.file), kind, index: args.pick, name: src.name || null }, ...r }, null, 2));
  else console.log(toCurl(r));
  for (const s of r.secrets) console.error(`secret: ${s.what} → $${s.env} (the test reads it from the environment; the value was not copied)`);
  for (const n of r.notes) console.error(`note: ${n}`);
  return 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (e) { if (e instanceof BadInput) { console.error(`request-from: ${e.message}`); process.exitCode = 2; } else throw e; }
