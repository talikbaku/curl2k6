# Azure DevOps tests (offline)

No Azure account needed. Three levels:

1. **Schema** — both pipelines against Microsoft's official Azure Pipelines schema:
   ```bash
   curl -sSfL -o /tmp/service-schema.json https://raw.githubusercontent.com/microsoft/azure-pipelines-vscode/main/service-schema.json
   python3 tests/azure/validate_schema.py /tmp/service-schema.json \
     plugins/curl2k6/skills/curl2k6/templates/azure-pipelines.yml examples/azure-pipelines.demo.yml
   ```
2. **Job emulation** — runs the `bash:` steps the way an agent does (`${{ parameters.* }}`, `$(Macros)`, `##vso[task.prependpath]`, `publish:`), validates parameters against `values:`:
   ```bash
   HIDE_K6=1 python3 tests/azure/azrun.py examples/azure-pipelines.demo.yml "$PWD" profiles=low
   ```
3. **Skill against an emulated `az`** — `az_emulator.py` answers `az pipelines create / run / runs show / runs artifact download` with REST-shaped JSON and runs the YAML locally, so Claude Code with the plugin can be tested end to end ("run the load test through an Azure pipeline"). It is not Azure: no remote checkout, queues, approvals or real agents.

What this does **not** prove: a real Azure DevOps run (agent images, permissions, approvals, artifacts service). Do one real run before relying on it.
