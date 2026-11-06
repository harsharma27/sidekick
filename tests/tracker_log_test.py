#!/usr/bin/env python3
"""Tests for tools/tracker_log.py. Run: python3 -I tests/tracker_log_test.py (repo root).
Synthetic data only; no tracker data is stored in the repo."""
import base64, importlib.util, io, json, os, subprocess, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOL = os.path.join(ROOT, 'tools', 'tracker_log.py')
spec = importlib.util.spec_from_file_location('tracker_log', TOOL)
tl = importlib.util.module_from_spec(spec); spec.loader.exec_module(tl)

fails = 0
def check(name, ok, detail=''):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '\n  ' + str(detail)))
    fails += 0 if ok else 1

def run(*args):
    p = subprocess.run([sys.executable, '-I', TOOL] + list(args), capture_output=True, text=True)
    return p.returncode, p.stdout

tmp = tempfile.mkdtemp()
exp = os.path.join(tmp, 'export', 'items'); os.makedirs(exp)
rows = {
    'a1': {'status': 'open', 'title': 'A "quoted" — é', 'court': 'X', 'log': [{'d': '2026-11-05', 't': 'line\nwith newline'}]},
    'a2': {'status': 'done', 'title': 'old', 'updated': '2026-10-01T00:00:00Z', 'log': []},
    'pf1': {'status': 'reference', 'group': 'Platform facts', 'facts': ['f1']},
}
for k, v in rows.items():
    json.dump({'id': k, 'data': v, 'version': 3}, open(os.path.join(exp, k + '.json'), 'w'))

log = os.path.join(tmp, 'log.txt')
c, out = run('seed', os.path.join(tmp, 'export'), log, 'all')
check('seed all writes every row', c == 0 and json.loads(out)['rows'] == 3, out)
c, out = run('replay', log, os.path.join(tmp, 'rep'))
check('replay of a seed restores the rows', c == 0 and json.loads(out)['rows'] == 3, out)
c, out = run('diff', os.path.join(tmp, 'export'), os.path.join(tmp, 'rep'), 'all')
check('diff: replay equals export exactly (unicode, quotes, newlines)', c == 0, out)

c, out = run('seed', os.path.join(tmp, 'export'), os.path.join(tmp, 'act.txt'), 'active')
check('active seed skips old done rows, keeps open and Platform facts', c == 0 and json.loads(out)['rows'] == 2, out)

text = open(log, encoding='utf-8').read()
e1 = tl.make_event('a1', 'SET', {'status': 'done', 'court': ''}, '2026-11-06T22:00:00Z')
e2 = tl.make_event('a1', 'LOG', {'d': '2026-11-06', 't': 'closed'}, '2026-11-06T22:00:00Z')
r, n = tl.replay(text + e1 + '\n' + e2 + '\n' + e2 + '\n')
check('SET overwrites fields', r['a1']['status'] == 'done' and r['a1']['court'] == '', r['a1'])
check('LOG appends and keeps earlier lines', [l['t'] for l in r['a1']['log']] == ['line\nwith newline', 'closed'], r['a1']['log'])
check('a duplicated line is applied once', n == 5, n)

# Google Docs text export: BOM + CRLF
docs = ('﻿' + text.replace('\n', '\r\n')).encode('utf-8')
p = os.path.join(tmp, 'docs.txt'); open(p, 'wb').write(docs)
c, out = run('replay', p, os.path.join(tmp, 'rep2'))
check('replay tolerates the Docs export BOM and CRLF', c == 0 and json.loads(out)['rows'] == 3, out)
p = os.path.join(tmp, 'b64.txt'); open(p, 'w').write(base64.b64encode(docs).decode())
c, out = run('replay', p, os.path.join(tmp, 'rep3'))
check('replay accepts the base64 download_file_content string', c == 0 and json.loads(out)['rows'] == 3, out)
lines = text.split('\n')
p1 = os.path.join(tmp, 's1.txt'); open(p1, 'w', encoding='utf-8').write('\n'.join(lines[:2]))
p2 = os.path.join(tmp, 's2.txt'); open(p2, 'w', encoding='utf-8').write('\n'.join(lines[2:]))
p3 = os.path.join(tmp, 'live.txt'); open(p3, 'w', encoding='utf-8').write('# live\n' + e1 + '\n')
c, out = run('replay', p1, p2, p3, os.path.join(tmp, 'rep4'))
r4 = json.load(open(os.path.join(tmp, 'rep4', 'items', 'a1.json')))
check('replay joins seed files then the live Doc, in order', c == 0 and json.loads(out)['rows'] == 3 and r4['status'] == 'done', out)

for name, bad in [('malformed JSON line refused', text + '{"v":1,broken\n'),
                  ('event on an unknown row refused', text + tl.make_event('zz', 'SET', {'status': 'x'}) + '\n'),
                  ('SET that replaces log refused', text + '{"v":1,"e":"x1","ts":"t","id":"a1","op":"SET","set":{"log":[]}}\n')]:
    p = os.path.join(tmp, 'bad.txt'); open(p, 'w', encoding='utf-8').write(bad)
    c, out = run('replay', p, os.path.join(tmp, 'repbad'))
    check(name + ' (exit 2)', c == 2, (c, out))

lg = os.path.join(tmp, 'append.log'); open(lg, 'w', encoding='utf-8').write(text)
before = open(lg, encoding='utf-8').read()
c, out = run('append', lg, 'a1', 'LOG', '{"d":"2026-11-07","t":"appended via append"}')
r5 = tl.replay(open(lg, encoding='utf-8').read())[0]
check('append adds a LOG line that replays', c == 0 and r5['a1']['log'][-1]['t'] == 'appended via append', (c, out))
size = os.path.getsize(lg)
c, out = run('append', lg, 'zz', 'SET', '{"status":"done"}')
check('append to an unknown row is refused and the file is untouched', c == 2 and os.path.getsize(lg) == size, (c, out))
c, out = run('append', lg, 'a1', 'SET', '{"log":[]}')
check('append refuses a SET that replaces log, file untouched', c == 2 and os.path.getsize(lg) == size, (c, out))
c, out = run('append', lg, 'n1', 'NEW', '{"status":"open","title":"new row","log":[]}')
check('append can create a new row', c == 0 and 'n1' in tl.replay(open(lg, encoding='utf-8').read())[0], (c, out))
c, out = run('event', 'a1', 'SET', '{"log":[]}')
check('event helper refuses SET on log', c == 2, out)
print('\n' + ('ALL PASS' if not fails else '%d FAILED' % fails))
sys.exit(1 if fails else 0)
