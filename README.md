# curl2k6

[![test](https://github.com/talikbaku/curl2k6/actions/workflows/test.yml/badge.svg)](https://github.com/talikbaku/curl2k6/actions/workflows/test.yml)
![license](https://img.shields.io/badge/license-MIT-blue)
![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)

**Paste a curl → get a k6 load test, a report, and a computed answer to "did this release get slower?"**

A Claude Code plugin for QA and performance engineers.

![Claude Code re-runs a load test after a release and flags the regression](docs/media/claude-session.gif)

## ⚡ TL;DR

- **In:** a curl (or a HAR, Postman or OpenAPI request).
- **Out:** a k6 test in your repo, runs locally or in your CI, a markdown/wiki report.
- **Verdict:** computed by a script against the last report, not guessed by the LLM.

## 🤖 Don't want to read? Copy this to your AI

Click the copy button on the block and paste it into Claude Code (or any assistant):

```text
Set up curl2k6 for me (https://github.com/talikbaku/curl2k6) — a Claude Code plugin that turns a curl into a k6 load test, runs it, writes a report and checks for regressions against the previous run.
1. Check that k6 and Node.js >= 22 are installed; tell me how to install what's missing.
2. Install the plugin: /plugin marketplace add talikbaku/curl2k6 then /plugin install curl2k6@curl2k6
3. Run /curl2k6 init in my test repo and ask me the setup questions in one block.
4. Then I'll give you a curl. Never ask me to paste a token — tests read it from an env var.
Short docs: https://github.com/talikbaku/curl2k6/blob/main/llms.txt
```

## 🚀 Install

```
/plugin marketplace add talikbaku/curl2k6
/plugin install curl2k6@curl2k6
```

Needs [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) and Node.js ≥ 22.

## ▶️ Use

```
/curl2k6 curl -H 'Authorization: Bearer <TOKEN>' https://api.stage.example.com/v2/items
```

1. **First time:** one block of questions → saved to `.curl2k6.yml`. Never asked again.
2. **Every run:** draft test → your OK → smoke → LOW / MEDIUM / HIGH → report.
3. **After a release:** *"re-run the load test, did it get slower?"* → comparison with the last report.

What it learns along the way (IP allowlists, caches, root causes) goes to `CURL2K6-FACTS.md`.

## 📊 What you get

| Profile | Metric | Previous | Current | Δ | |
|---|---|---|---|---|---|
| LOW | p95 ms | 29.19 | 41.95 | +43.7% | ⚠ regression |
| HIGH | p95 ms | 35.06 | 92.93 | +165.1% | ⚠ regression |
| HIGH | timeouts | 0 | 0 | ±0.00 pp | ✓ |

Full examples: [baseline](examples/reports/items-api-2026-10-09-local-baseline.md) · [regression](examples/reports/items-api-2026-10-09-local-regression.md)

## 🛡️ Safe by default

- 🔑 **Tokens stay in env vars**: never in tests, commits, reports or the chat.
- 🏭 **Production**: every run needs your explicit OK, one profile at a time.
- 🧮 **No apples-to-oranges**: a different load or environment is never called a regression.

## 🧪 Try without Claude (2 min)

```bash
git clone https://github.com/talikbaku/curl2k6.git && cd curl2k6 && bash examples/run-demo.sh
```

Nothing installed? [![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/talikbaku/curl2k6?quickstart=1)

## 📚 More

- [docs/MORE.md](docs/MORE.md): HAR/Postman/OpenAPI input, profiles, limits, CI gate without Claude, comparison with other tools
- [docs/GUIDE.md](docs/GUIDE.md): the full flow, step by step
- [CHANGELOG.md](CHANGELOG.md) · `npm test` for development

[MIT](LICENSE) © 2026 Talat Gurbanbayov
