import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dir = new URL('../plugins/curl2k6/skills/curl2k6/templates/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');

test('claude-settings.json: valid JSON, no rule that would let production or pushes through silently', () => {
  const allow = JSON.parse(read('claude-settings.json')).permissions.allow;
  assert.ok(Array.isArray(allow) && allow.length > 0);
  assert.ok(!allow.includes('Bash(k6 run:*)'), 'bare k6 run would allow production runs without a prompt');
  for (const rule of allow) {
    if (rule.startsWith('Bash(k6 run')) assert.match(rule, /^Bash\(k6 run -e TARGET_ENV=/);
    assert.doesNotMatch(rule, /git push|Bash\(curl|\.env\b|secret/i, rule);
  }
});

test('curl2k6.yml: names the facts file and holds no secret-looking values', () => {
  const yml = read('curl2k6.yml');
  assert.match(yml, /^facts_file: CURL2K6-FACTS\.md/m);
  assert.match(yml, /^version: 1$/m);
  assert.doesNotMatch(yml, /(token|key|password|secret)\s*:\s*['"]?[A-Za-z0-9-_]{16,}/i);
});

test('facts.md: has the three sections the skill writes into', () => {
  const md = read('facts.md');
  for (const s of ['## Environments', '## Endpoints', '## Decisions']) assert.ok(md.includes(s), s);
});
