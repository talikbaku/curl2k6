# curl2k6 on Azure DevOps — first real run

What's already verified offline: both pipelines pass Microsoft's Azure Pipelines schema, their steps run correctly in a job emulator, and Claude Code with the plugin drives an emulated `az` correctly end to end (creates the pipeline, selects the profile with runtime parameters, polls, downloads the artifact, compares). What only a real run can show: agents, permissions/approvals, the artifacts service. This page is the checklist for that run.

## 1. Prerequisites (on the machine where Claude Code runs)

```bash
az --version                                  # Azure CLI
az extension add --name azure-devops          # once
az login                                      # or: export AZURE_DEVOPS_EXT_PAT=<PAT>  (Build: Read & execute; Code: Read & write)
az devops configure -d organization=https://dev.azure.com/<org>/ project=<project>
az devops project show --project <project> --query name -o tsv   # must print the project name
k6 version && node --version                  # node >= 22
```

Agent: Microsoft-hosted (`vmImage: ubuntu-latest`) reaches only public URLs, and a new organization may have no hosted parallelism yet (runs wait in the queue). A **self-hosted agent** (one is free) works right away and can reach whatever your machine/network can: *Project settings → Agent pools → Add pool (self-hosted) → New agent*, follow the 4 commands shown there.

## 2. Smoke test without Claude (5 min)

Proves the agent, k6 install and artifacts work. Push this repo (or a fork) to Azure Repos, then:
```bash
az pipelines create --name curl2k6-demo --yml-path examples/azure-pipelines.demo.yml --branch main --skip-first-run true
az pipelines run --name curl2k6-demo --branch main --parameters profiles=low
```
For a self-hosted agent, change `pool:` in `examples/azure-pipelines.demo.yml` to `name: <your pool>` first. Expected: run succeeds; the "Regression gate" step shows a warning (the demo's bad release is detected on purpose); artifact `curl2k6-demo` contains `baseline/` and `current/`.

## 3. Real run with Claude Code

In the repo of the service you want to cover:
```
/curl2k6 here's the curl: curl ... — run it through Azure DevOps (org https://dev.azure.com/<org>/, project <project>),
self-hosted pool <pool>, environment <env>, profiles LOW then MEDIUM, report to load-reports/ and Confluence space <space> under <parent page>
```
What to watch:
- it adds `load/azure-pipelines.yml` from the template, commits and **pushes** before `az pipelines create` (Azure runs the remote branch);
- `az pipelines run ... --parameters profile=low` — parameters, never `--variables`;
- the first run of a new pipeline on a pool may wait for a **permission approval** in the UI (status `notStarted`). Approve it there; Claude shouldn't queue a second run;
- after each run: artifact `curl2k6-<profile>` downloaded, `meta.profile` in the summary matches what was requested;
- the report: tables, Runs (add the build URL), comparison from `compare.mjs`.

If anything differs from this list, that's a bug in the recipe (`plugins/curl2k6/skills/curl2k6/references/ci-azure-devops.md`) — note what Azure actually returned.
