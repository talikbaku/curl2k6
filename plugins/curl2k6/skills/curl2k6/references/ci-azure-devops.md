# Azure DevOps (Azure Pipelines) — recipe

Read when the repo has `azure-pipelines.yml` / `*.yml` pipelines under Azure Repos, or the user says Azure DevOps / ADO / Azure Pipelines / TFS.
Everything goes through the `az` CLI with the `azure-devops` extension (`az extension add --name azure-devops`), the same way a person would from a terminal.

## Before the first run (ask / check, don't guess)

- **Organization URL and project** — `https://dev.azure.com/<org>/`, project name. Set defaults once: `az devops configure -d organization=<url> project=<name>`. Often auto-detected from an Azure Repos git remote.
- **Auth** — either `az login` already done by the user, or a PAT in `AZURE_DEVOPS_EXT_PAT` (scopes: Build — Read & execute; Code — Read & write only if Claude pushes). Check with `az devops project show --project <name> --query name -o tsv`. Never ask for the PAT in the chat; if missing, ask the user to `export AZURE_DEVOPS_EXT_PAT=...` in their own terminal.
- **Agent pool** — Microsoft-hosted (`vmImage: ubuntu-latest`) runs from Microsoft's public IPs, so "the URL is public" is not enough: a service behind an IP allowlist (observed: Cloudflare in front of the API) answers hosted agents with `403` / body `Your IP address is not allowed` (k6 `error_code` 1403), while the same URL works from the team's own pool. Find out which pool the team's existing pipelines use (`az pipelines pool list`, and `pool:` in their YAML) and which one is allowed to reach the target, before choosing. A self-hosted pool can show **0 online agents** and still work: autoscaled agents (e.g. KEDA, `azure-devops-agent-keda-…`) are created per run — don't rule a pool out by its online count, queue a short smoke run instead. A service reachable only from the company network needs a self-hosted pool anyway. New organizations may have no hosted parallelism yet (runs stay queued with a message about parallelism); on the org this was verified on, a hosted run was picked up within ~10 s.
- **Prove the target answers before the real run** — from the main conversation (with the same confirmation as any run if it's production), not from the background runner: `--parameters profile=smoke` (1 req/s for 20 s, in the template). The test template logs the status and the first ~200 chars (secrets redacted) of the first few non-2xx responses as `diag status=` lines.
- **Commit-author email policy:** a push can be rejected with `error VS403702: ... author email '<email>' which does not match the policy-specified patterns`. Azure doesn't say which pattern is allowed — ask the user for the address they commit with, set `git config user.email` in that repo (not globally), and rewrite author/committer only in the copy you push.
- **Existing pipeline?** `az pipelines list --query "[].{id:id,name:name,path:path}" -o table`. If the repo already has a load-test pipeline, use it and its parameters. Otherwise start from `templates/azure-pipelines.yml`, commit it with the test, **push it** (Azure runs the YAML and the test from the remote branch, never from your working copy — if the push fails, stop and say so instead of running), and create the pipeline once:
  `az pipelines create --name <name> --yml-path <path/to/azure-pipelines.yml> --branch <branch> --skip-first-run true`
  (for a GitHub-hosted repo add `--repository <owner/repo> --repository-type github --service-connection <id>`).

## Selecting the profile — the Azure-specific trap

A variable defined in the YAML `variables:` block **can't be overridden at queue time** — `az pipelines run --variables LOAD_PROFILE=high` is silently ignored and the run uses the YAML value (Microsoft docs: "If a variable appears in the variables block of a YAML file, its value is fixed and users can't override it at queue time"). LOW can silently run as HIGH or the other way round.

- Prefer **runtime parameters** (`parameters:` with `values: [smoke, low, medium, high]`, as in `templates/azure-pipelines.yml`): `az pipelines run --name <name> --branch <branch> --parameters profile=low targetEnv=stage`. The template passes parameters to the script as environment variables, strips every `$` (no Azure macros like `$(System.AccessToken)`), validates them, and only accepts a `baseUrl` whose host is in `ALLOWED_HOSTS` — a YAML value, so whoever can only queue runs can't redirect the key elsewhere. When generating the pipeline, set `ALLOWED_HOSTS` to the host(s) from the curl; keep production hosts out unless the pipeline is meant for production (then protect it with Azure approvals).
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

- `status` stuck at `notStarted` for minutes: usually a pending approval/permission on first use, or no free agent/parallelism. Observed: a **new pipeline that references a variable group** waits until someone permits the group for that pipeline — the run timeline (`az devops invoke --area build --resource timeline --route-parameters project=<p> buildId=<id>`) shows a `Checkpoint.Authorization` record in `inProgress`, and `GET _apis/pipelines/pipelinepermissions/variablegroup/<groupId>?api-version=7.1-preview.1` lists only the pipelines already authorized. Using a self-hosted pool the team already uses needed no approval. Tell the user what to permit in the UI (run page → "Permit"); **don't queue the run again** (a second run doubles the load once it's unblocked) and don't grant access to a shared secret store yourself without their say-so. The waiting run starts by itself after the permit.
- `result: failed` with the k6 step failing: read the step log first. `k6 exit code: 99` + "k6 thresholds crossed" = a **complete** run whose thresholds failed (template default `onThresholds=fail`) — the artifact is still published, download it and report as usual. Any other exit code = k6 didn't run properly; report that, don't use numbers.
- Whatever the result, check `success_rate` in the summary before using any numbers. Observed in the first real run (with exit 99 then tolerated): a `succeeded` run in which 1094/1094 responses were 4xx. If it is far below 100%, read the `diag status=` lines in `k6-<profile>.log` (in the artifact), don't start the next profile, and report. Pipelines created from the older template (or with `onThresholds=warn`) still turn green on crossed thresholds.
- No artifact: the k6 log is also inside the artifact; if the publish step didn't run, get the step log through the run page (`url` above) or the REST API — `to-raw.mjs` reads the `K6_SUMMARY_JSON` line from any saved log.
- `startTime` / `finishTime` of the run are the CI timestamps; the Runs table in the report uses the k6 times from the summary — add the run URL to it.

## Secrets

Secret pipeline variables are not passed to scripts automatically: map them in the step (`env: API_TOKEN: $(API_TOKEN)`), and read them in the test via `__ENV.API_TOKEN` (k6 sees the step's environment, so no `-e` on the command line is needed). Never put the value into the YAML or a URL query string. Azure masks secrets in the live log but **not in files**: the template scrubs the env vars listed in `SECRET_ENV_NAMES` (default `API_TOKEN`; comma-separated lists split) from the k6 log before it is published as an artifact — add every secret env var you map to that list. Values shorter than 6 characters and encoded copies (URL-encoded, base64, JSON-escaped) are not caught — keep secrets out of URLs and bodies the API echoes.

Secrets kept in a **variable group** (Library) need `variables: - group: <name>` in the YAML and the group must be permitted for the new pipeline (see `notStarted` above). To see which variables a group has without reading values: `az pipelines variable-group list --group-name <name> --query "[].{id:id,vars:keys(variables)}"`. A variable may hold a **list** (e.g. several keys separated by commas, if that is how the team's other tests use it) — the test must split it; sending the whole string gave `401 invalid ApiKey` here.

## Wiki report page

`az devops wiki page create --wiki <wiki> --path "<parent>/<title>" --file-path <report.md> --org <url> --project <p>` creates the page (returns its id). The parent's **path uses the page title with spaces** (`/QA documents`), while the browser URL shows the slug (`QA-documents`) — a path built from the URL is "could not be found". `az devops wiki page show` needs `--path` (not an id); to map an id from a URL to a path, list pages: `az devops invoke --area wiki --resource pagesBatch --route-parameters project=<p> wikiIdentifier=<wiki> --http-method POST --in-file <file with {"top":100}>` and follow `continuation_token` (put it into the body as `continuationToken`); a request with `top` 500 produced no JSON output here, 100 works.

## Gating a pipeline on regressions (optional, if the team wants it)

Copy `scripts/to-raw.mjs` and `scripts/compare.mjs` into the repo next to the test, keep the last accepted report in the repo, make sure the agent has Node ≥ 22 (`NodeTool@0` with `versionSpec: 22.x`), and add a step after the k6 step:
```yaml
  - bash: |
      node load/to-raw.mjs "$(Build.ArtifactStagingDirectory)/curl2k6"/summary-*.json --format json > raw.json
      node load/compare.mjs --prev load-reports/<last accepted report>.md --curr raw.json --format text --fail-on-regression
    displayName: Regression gate
    condition: succeededOrFailed()      # the k6 step is red when thresholds are crossed (onThresholds=fail)
    env:
      FORCE_COLOR: '1'
```
Exit 1 = regression on a comparable profile; exit 2 = bad input (also fails the pipeline — read the message).
