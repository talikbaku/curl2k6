# Emulated `az` (azure-devops extension subset) for offline testing of the curl2k6 Azure DevOps flow.
# Runs the pipeline locally with azrun.py; outputs mimic Azure DevOps REST Build objects.
# NOT Azure: no queues, approvals, remote checkout or real agents — it runs the YAML in the current
# directory. Use it to test the skill's decisions (create/run/poll/download), then do one real run.
# Usage: put a wrapper named `az` on PATH that runs this file; set AZSHIM_AZRUN=<path to azrun.py>,
#        optionally AZSHIM_STATE / AZSHIM_LOG. Needs: pip install jmespath pyyaml
import json, os, sys, subprocess, time, shutil, jmespath, datetime
STATE = os.environ.get('AZSHIM_STATE', '/tmp/azshim-state.json')
LOG = os.environ.get('AZSHIM_LOG', '/tmp/azshim-calls.log')
AZRUN = os.environ['AZSHIM_AZRUN']
ORG = 'https://dev.azure.com/demo-org/'
args = sys.argv[1:]
open(LOG, 'a').write(' '.join(args) + '\n')
st = json.load(open(STATE)) if os.path.exists(STATE) else {'pipelines': {}, 'runs': {}}
def save(): json.dump(st, open(STATE, 'w'), indent=1)
def opt(name, multi=False):
    if name not in args: return None
    i = args.index(name); vals = []
    for a in args[i + 1:]:
        if a.startswith('--'): break
        vals.append(a)
    return vals if multi else (vals[0] if vals else True)
def out(obj):
    q = opt('--query'); fmt = opt('--output') or opt('-o') or 'json'
    if q: obj = jmespath.search(q, obj)
    if fmt == 'tsv':
        if isinstance(obj, list): print('\n'.join('\t'.join(map(str, x.values())) if isinstance(x, dict) else str(x) for x in obj))
        elif isinstance(obj, dict): print('\t'.join(map(str, obj.values())))
        else: print(obj)
    elif fmt == 'table' and isinstance(obj, list) and obj and isinstance(obj[0], dict):
        keys = list(obj[0]); print('  '.join(keys)); [print('  '.join(str(o.get(k)) for k in keys)) for o in obj]
    else: print(json.dumps(obj, indent=2))
iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
def run_obj(rid):
    r = st['runs'][rid]
    if r['status'] != 'completed' and r.get('pid'):
        try: os.kill(r['pid'], 0); alive = True
        except OSError: alive = False
        done = os.path.exists(r['out']) and 'JOB ' in open(r['out']).read()
        if done or not alive:
            txt = open(r['out']).read()
            r['status'] = 'completed'; r['result'] = 'succeeded' if 'JOB SUCCEEDED' in txt else 'failed'
            r['finishTime'] = iso(time.time())
            pub = [l.split(' ', 1)[1] for l in txt.splitlines() if l.startswith('published: ')]
            r['published'] = pub[0] if pub else None
            save()
        elif time.time() - r['queued'] > 2: r['status'] = 'inProgress'
    return {'id': int(rid), 'buildNumber': f'20261008.{rid}', 'status': r['status'], 'result': r.get('result'),
            'queueTime': iso(r['queued']), 'startTime': iso(r['queued'] + 1), 'finishTime': r.get('finishTime'),
            'definition': {'id': r['pid_def'], 'name': r['name']}, 'sourceBranch': r['branch'],
            'templateParameters': r['params'],
            '_links': {'web': {'href': f'{ORG}items-service/_build/results?buildId={rid}'}}}
cmd = ' '.join(a for a in args[:4] if not a.startswith('--'))
if args[:1] == ['--version'] or args[:1] == ['version']:
    print('azure-cli 2.67.0\nExtensions:\nazure-devops 1.0.1'); sys.exit(0)
if cmd.startswith('extension'):
    print(json.dumps([{'name': 'azure-devops', 'version': '1.0.1'}])); sys.exit(0)
if cmd.startswith('devops configure'): sys.exit(0)
if cmd.startswith('devops project show') or cmd.startswith('devops project list'):
    out({'name': 'items-service', 'id': 'p1', 'state': 'wellFormed'}); sys.exit(0)
if cmd.startswith('account show'): out({'user': {'name': 'talat'}}); sys.exit(0)
if cmd.startswith('pipelines list'):
    out([{'id': p['id'], 'name': n, 'path': '\\'} for n, p in st['pipelines'].items()]); sys.exit(0)
if cmd.startswith('pipelines show'):
    n = opt('--name'); p = st['pipelines'].get(n) or next((dict(v, name=k) for k, v in st['pipelines'].items() if str(v['id']) == str(opt('--id'))), None)
    if not p: print('ERROR: pipeline not found', file=sys.stderr); sys.exit(1)
    out({'id': p['id'], 'name': n or p.get('name'), 'process': {'yamlFilename': p['yml']}}); sys.exit(0)
if cmd.startswith('pipelines create'):
    n = opt('--name'); yml = opt('--yml-path') or opt('--yaml-path')
    if not yml or not os.path.exists(yml): print(f'ERROR: yaml file {yml} not found in repo', file=sys.stderr); sys.exit(1)
    st['pipelines'][n] = {'id': len(st['pipelines']) + 1, 'yml': yml}; save()
    out({'id': st['pipelines'][n]['id'], 'name': n, 'process': {'yamlFilename': yml}}); sys.exit(0)
if cmd.startswith('pipelines run') and not cmd.startswith('pipelines runs'):
    n = opt('--name'); p = st['pipelines'].get(n)
    if not p: print(f"ERROR: Pipeline '{n}' not found", file=sys.stderr); sys.exit(1)
    params = dict(x.split('=', 1) for x in (opt('--parameters', True) or []))
    if opt('--variables', True): open(LOG, 'a').write('  NOTE: --variables given (YAML vars would ignore it)\n')
    rid = str(len(st['runs']) + 101)
    o = f'/tmp/azshim-run-{rid}.out'
    proc = subprocess.Popen(['python3', '-I', AZRUN, p['yml'], os.getcwd()] + [f'{k}={v}' for k, v in params.items()],
                            stdout=open(o, 'w'), stderr=subprocess.STDOUT, start_new_session=True)
    st['runs'][rid] = {'pid': proc.pid, 'out': o, 'status': 'notStarted', 'queued': time.time(), 'name': n,
                       'pid_def': p['id'], 'branch': f"refs/heads/{opt('--branch') or 'main'}", 'params': params}
    save(); out(run_obj(rid)); sys.exit(0)
if cmd.startswith('pipelines runs show'):
    rid = str(opt('--id'))
    if rid not in st['runs']: print('ERROR: run not found', file=sys.stderr); sys.exit(1)
    out(run_obj(rid)); sys.exit(0)
if cmd.startswith('pipelines runs list'):
    out([run_obj(r) for r in st['runs']]); sys.exit(0)
if cmd.startswith('pipelines runs artifact'):
    rid = str(opt('--run-id')); r = st['runs'].get(rid)
    if not r: print('ERROR: run not found', file=sys.stderr); sys.exit(1)
    run_obj(rid); pub = st['runs'][rid].get('published')
    names = sorted(os.listdir(pub)) if pub and os.path.isdir(pub) else []
    if 'list' in args: out([{'name': x, 'resource': {'type': 'PipelineArtifact'}} for x in names]); sys.exit(0)
    a = opt('--artifact-name'); dst = opt('--path')
    if a not in names: print(f"ERROR: Artifact '{a}' not found for run {rid}", file=sys.stderr); sys.exit(1)
    shutil.copytree(os.path.join(pub, a), dst, dirs_exist_ok=True); print(f'Downloading artifact {a} to {dst}... done'); sys.exit(0)
print(f"ERROR: az {' '.join(args)}: not supported by this emulated environment", file=sys.stderr); sys.exit(2)
