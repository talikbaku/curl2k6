# Validate Azure Pipelines YAML files against the official schema:
#   curl -sSfL -o service-schema.json https://raw.githubusercontent.com/microsoft/azure-pipelines-vscode/main/service-schema.json
#   python3 tests/azure/validate_schema.py service-schema.json <pipeline.yml> ...   (needs: pip install jsonschema pyyaml)
import json, sys, yaml, jsonschema
schema = json.load(open(sys.argv[1]))
V = jsonschema.Draft7Validator(schema)
ok = True
for f in sys.argv[2:]:
    doc = yaml.safe_load(open(f))
    errs = sorted(V.iter_errors(doc), key=lambda e: list(e.path))
    # report the most specific errors only
    leaf = [e for e in errs]
    print(f"{f}: {'VALID' if not errs else f'{len(errs)} error(s)'}")
    for e in leaf[:15]:
        print('   ', list(e.absolute_path), '-', e.message[:200])
        for c in (e.context or [])[:3]: print('       ctx:', list(c.absolute_path), c.message[:160])
    ok &= not errs
sys.exit(0 if ok else 1)
