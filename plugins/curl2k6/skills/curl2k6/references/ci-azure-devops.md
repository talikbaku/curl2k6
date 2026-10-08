# Azure DevOps (Azure Pipelines) — recipe

Read when the repo has `azure-pipelines.yml` / `*.yml` pipelines under Azure Repos, or the user says Azure DevOps / ADO / Azure Pipelines / TFS.
Everything goes through the `az` CLI with the `azure-devops` extension (`az extension add --name azure-devops`), the same way a person would from a terminal.

## Before the first run (ask / check, don't guess)

- **Organization URL and project** — `https://dev.azure.com/<org>/`, project name. Set defaults once: `az devops configure -d organization=<url> project=<name>`. Often auto-detected from an Azure Repos git remote.
- **Auth** — either `az login` already done by the user, or a PAT in `AZURE_DEVOPS_EXT_PAT` (scopes: Build — Read & execute; Code — Read & write only if Claude pushes). Check with `az devops project show --project <name> --query name -o tsv`. Never ask for the PAT in the chat; if missing, ask the user to `export AZURE_DEVOPS_EXT_PAT=...` in their own terminal.
- **Agent pool** — Microsoft-hosted (`vmImage: ubuntu-latest`) reaches only public endpoints. A service reachable only from the company network needs a **self-hosted** pool (`pool: name: <pool>`). This is the "where does k6 actually run" question. New organizations may have no hosted parallelism yet (runs stay queued with a message about parallelism) — a self-hosted agent works immediately.
- **Existing pipeline?** `az pipelines list --query "[].{id:id,name:name,path:path}" -o table`. If the repo already has a load-test pipeline, use it and its parameters. Otherwise start from `templates/azure-pipelines.yml`, commit it with the test, **push it** (Azure runs the YAML and the test from the remote branch, never from your working copy — if the push fails, stop and say so instead of running), and create the pipeline once:
  `az pipelines create --name <name> --yml-path <path/to/azure-pipelines.yml> --branch <branch> --skip-first-run true`
  (for a GitHub-hosted repo add `--repository <owner/repo> --repository-type github --service-connection <id>`).

## Selecting the profile — the Azure-specific trap

A variable defined in the YAML `variables:` block **can't be overridden at queue time** — `az pipelines run --variables LOAD_PROFILE=high` is silently ignored and the run uses the YAML value (Microsoft docs: "If a variable appears in the variables block of a YAML file, its value is fixed and users can't override it at queue time"). LOW can silently run as HIGH or the other way round.

- Prefer **runtime parameters** (`parameters:` with `values: [low, medium, high]`, as in `templates/azure-pipelines.yml`): `az pipelines run --name <name> --branch <branch> --parameters profile=low targetEnv=stage`.
- If the existing pipeline uses a variable instead, it must be defined in the pipeline UI with "Let users override this value when running this pipeline" and **not** in the YAML. Check before trusting `--variables`.
- Before triggering, make sure the branch you pass with `--branch` contains the commit you expect (`git ls-remote origin <branch>` vs `git rev-parse HEAD`); the report records `GIT_SHA` from the agent's checkout.
- After triggering, verify which profile actually ran: `summary-<profile>.json` / the `K6_SUMMARY_JSON` line carries `meta.profile` and `meta.plan` — compare them with what you asked for before using the numbers.

## Trigger, wait, collect

```bash
RUN_ID=$(az pipelines run --name <name> --branch <branch> --parameters profile=low targetEnv=<env> --query id -o tsv)

# poll with single short calls (no long sleep): status notStarted|inProgress|completed, result succeeded|failed|partiallySucceeded|canceled
az pipelines runs show --id "$RUN_ID" --query "{status:status,result:result,start:startTime,finish:finishTime,url:_links.web.href}" -o json

# when completed: artifacts from the template are named curl2k6-<profile>
RUN_DIR=<run folder>; mkdir -p "$RUN_DIR"
az pipelines runs artifact download --run-id "$RUN_ID" --artifact-name curl2k6-low --path "$RUN_DIR"
```

- `status` stuck at `notStarted` for minutes: usually a pending approval/permission for the pool or an environment on first use, or no free agent/parallelism. Tell the user what to approve in the UI — **don't queue the run again** (a second run doubles the load once it's unblocked).
- `result: failed` with the k6 step failing: read the log before anything else. The template exits 0 on k6 exit code 99 (thresholds crossed — a complete run), so a failed step means k6 didn't run properly.
- No artifact: the k6 log is also inside the artifact; if the publish step didn't run, get the step log through the run page (`url` above) or the REST API — `to-raw.mjs` reads the `K6_SUMMARY_JSON` line from any saved log.
- `startTime` / `finishTime` of the run are the CI timestamps; the Runs table in the report uses the k6 times from the summary — add the run URL to it.

## Secrets

Secret pipeline variables are not passed to scripts automatically: map them in the step (`env: API_TOKEN: $(API_TOKEN)`), and read them in the test via `__ENV.API_TOKEN`. Never put the value into the YAML.

## Gating a pipeline on regressions (optional, if the team wants it)

Copy `scripts/compare.mjs` into the repo next to the test, keep the last accepted report in the repo, and add a step after the run:
```bash
node load/compare.mjs --prev load-reports/<last accepted report>.md --curr "$RUN/raw.json" --format text --fail-on-regression
```
(`raw.json` from `to-raw.mjs`, which then also has to be copied.) Exit 1 fails the pipeline only for regressions on comparable profiles.
