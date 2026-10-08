#!/usr/bin/env node
// Tiny demo target for curl2k6 — no dependencies.
//   node examples/demo-server.mjs            -> "healthy" service on :8099
//   SLOW=1 node examples/demo-server.mjs     -> same service after a "bad release": slower, more 5xx
//
// GET /items?limit=N  — latency grows with the number of in-flight requests (like a real service
// with a small connection pool), ~0.1% of requests fail with 503 (more in SLOW mode).

import http from 'node:http';

const PORT = Number(process.env.PORT || 8099);
const SLOW = process.env.SLOW === '1';
const BASE_MS = SLOW ? 28 : 18;
const PER_INFLIGHT_MS = SLOW ? 4 : 1.5;
const ERROR_RATE = SLOW ? 0.02 : 0.001;

let inflight = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method !== 'GET' || url.pathname !== '/items') {
    res.writeHead(404).end();
    return;
  }
  inflight++;
  const jitter = Math.random() * 10;
  const delay = BASE_MS + PER_INFLIGHT_MS * inflight + jitter;
  setTimeout(() => {
    inflight--;
    if (Math.random() < ERROR_RATE) {
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"busy"}');
      return;
    }
    const limit = Math.min(Number(url.searchParams.get('limit') || 10), 100);
    const items = Array.from({ length: limit }, (_, i) => ({ id: i + 1, name: `item-${i + 1}` }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items }));
  }, delay);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`demo-server on http://127.0.0.1:${PORT} (${SLOW ? 'SLOW — simulated bad release' : 'healthy'})`);
});
