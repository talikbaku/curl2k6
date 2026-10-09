# Minimal local emulation of an Azure Pipelines job (tests only — not a replacement for a real agent):
#   python3 azrun.py <pipeline.yml> <repo dir> [param=value ...]   (HIDE_K6=1 hides k6 from PATH to test the installer)
# expands ${{ parameters.* }} and $(Macro) like the
# agent does, runs `bash:` steps in order, honours ##vso[task.prependpath], emulates `publish:`.
import os, re, subprocess, sys, tempfile, yaml, shutil
pipeline, workdir = sys.argv[1], sys.argv[2]
params_in = dict(a.split('=', 1) for a in sys.argv[3:])
doc = yaml.safe_load(open(pipeline))
declared = {p['name']: p for p in doc.get('parameters', [])}
for k in params_in:
    assert k in declared, f'unknown parameter {k}'
params = {k: params_in.get(k, p.get('default')) for k, p in declared.items()}
for k, p in declared.items():
    if 'values' in p: assert params[k] in p['values'], f'{k}={params[k]} not in {p["values"]}'
used = set(re.findall(r'\$\{\{\s*parameters\.(\w+)\s*\}\}', open(pipeline).read()))
assert used <= set(declared), f'undeclared parameters used: {used - set(declared)}'
tmp = tempfile.mkdtemp(prefix='azagent-')
macros = {'Build.ArtifactStagingDirectory': f'{tmp}/a', 'Agent.TempDirectory': f'{tmp}/t', 'Build.SourcesDirectory': workdir}
os.makedirs(macros['Build.ArtifactStagingDirectory']); os.makedirs(macros['Agent.TempDirectory'])
def expand(s):
    s = re.sub(r'\$\{\{\s*parameters\.(\w+)\s*\}\}', lambda m: str(params[m.group(1)]), str(s))
    return re.sub(r'\$\(([\w.]+)\)', lambda m: macros.get(m.group(1), m.group(0)), s)
path_prefix = []
env_base = dict(os.environ)
if os.environ.get('HIDE_K6'):
    env_base['PATH'] = ':'.join(p for p in env_base['PATH'].split(':') if not os.path.exists(os.path.join(p, 'k6')))
failed = False
for i, step in enumerate(doc['steps']):
    name = expand(step.get('displayName', next(iter(step))))
    cond = str(step.get('condition', 'succeeded()')).replace(' ', '')
    if failed and cond not in ('succeededOrFailed()', 'always()', 'failed()'):
        print(f'[{i}] {name}: skipped (previous step failed, condition {cond})'); continue
    if not failed and cond == 'failed()':
        print(f'[{i}] {name}: skipped (condition failed())'); continue
    if 'bash' in step:
        env = dict(env_base); env['PATH'] = ':'.join(path_prefix + [env['PATH']])
        env.update({k: expand(v) for k, v in (step.get('env') or {}).items()})
        r = subprocess.run(['bash', '-c', expand(step['bash'])], cwd=workdir, env=env, capture_output=True, text=True)
        out = r.stdout + r.stderr
        for m in re.finditer(r'##vso\[task\.prependpath\](.+)', out): path_prefix.insert(0, m.group(1).strip())
        issues = re.findall(r'##vso\[task\.logissue type=(\w+)\](.+)', out)
        print(f'[{i}] {name}: exit {r.returncode}' + ''.join(f'\n      {t.upper()}: {msg}' for t, msg in issues))
        tail = [l for l in out.splitlines() if l.strip() and '##vso' not in l][-4:]
        for l in tail: print('      |', l[:150])
        if r.returncode != 0:
            failed = True
    elif 'publish' in step:
        src = expand(step['publish']); src = src if os.path.isabs(src) else os.path.join(workdir, src)
        dst = os.path.join(tmp, 'published', expand(step['artifact']))
        shutil.copytree(src, dst)
        print(f'[{i}] {name}: artifact "{expand(step["artifact"])}" -> {sorted(os.listdir(dst))}')
    else:
        print(f'[{i}] {name}: (not emulated: {next(iter(step))})')
print('JOB FAILED' if failed else 'JOB SUCCEEDED'); print('published:', os.path.join(tmp, 'published'))
sys.exit(1 if failed else 0)
