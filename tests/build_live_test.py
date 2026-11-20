#!/usr/bin/env python3
"""Regression test for tools/build_live.py pack items. Run: python3 -I tests/build_live_test.py (repo root).
Synthetic data only; no tracker data is stored in the repo."""
import datetime, importlib.util, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('build_live', os.path.join(ROOT, 'tools', 'build_live.py'))
bl = importlib.util.module_from_spec(spec); spec.loader.exec_module(bl)

fails = 0
def check(name, ok, detail=''):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '\n  ' + str(detail)))
    fails += 0 if ok else 1

static = {'me': {}, 'voice': '', 'people': [], 'stories': []}
today = datetime.date(2026, 11, 6)
log = [{'d': '2026-11-0%d' % i, 't': 'step %d' % i} for i in range(1, 8)] + [{'d': '2026-11-06', 't': 'Harsh chose not to send it. ' + 'x' * 900}]
items = {
    'a1': {'status': 'open', 'title': 'A', 'court': 'Pratyush', 'log': log},
    'a2': {'status': 'waiting', 'title': 'B', 'court': 'Sumeet', 'log': []},
}
pack = bl.build_pack(items, static, today)
rows = {r['id']: r for r in pack['items']}
check("'now' is the newest log line", rows['a1']['now']['d'] == '2026-11-06' and rows['a1']['now']['t'].startswith('Harsh chose not to send it.'), rows['a1']['now'])
check("'now' is clipped to 700 chars", len(rows['a1']['now']['t']) <= 700, len(rows['a1']['now']['t']))
check("log still keeps the last 5 lines, oldest first", [l['t'][:6] for l in rows['a1']['log']][:4] == ['step 4', 'step 5', 'step 6', 'step 7'], rows['a1']['log'])
check("court carried with the item", rows['a1']['court'] == 'Pratyush', rows['a1'])
check("item with no log gets an empty 'now'", rows['a2']['now'] == {}, rows['a2'])

# 20 Nov 2026: next: shows `next` then the latest log line; markdown stripped; LIVE_FORMAT in the fingerprint
def nx(d): return bl.line('a01', dict({'title': 'T', 'court': 'X'}, **d)).split('next: ')[1].rstrip(')')
L = [{'d': '2026-11-19', 't': '- **Sent** the draft'}]
check('next then log line', nx({'next': '**Send the fix** to QA', 'log': L}) == 'Send the fix to QA | Sent the draft', nx({'next': '**Send the fix** to QA', 'log': L}))
check('next only when no log', nx({'next': 'Ping QA', 'log': []}) == 'Ping QA')
check('empty and blank next fall back to the log line', nx({'next': '', 'log': L}) == 'Sent the draft' == nx({'next': '   ', 'log': L}))
check('identical next and log shown once', nx({'next': 'Sent the draft', 'log': L}) == 'Sent the draft')
check('no next and no log', nx({}) == 'no log yet')
check('leading bullet stripped, -5 days kept', nx({'log': [{'t': '- item'}]}) == 'item' and nx({'log': [{'t': '-5 days'}]}) == '-5 days')
check('next: clipped to 160', len(nx({'next': 'n' * 300, 'log': L})) <= 160)
check('fingerprint carries LIVE_FORMAT', bl.fingerprint(items, today) != __import__('hashlib').sha256((__import__('json').dumps(items, sort_keys=True, ensure_ascii=False) + today.isoformat()).encode()).hexdigest()[:12])
tspec = importlib.util.spec_from_file_location('tracker_log', os.path.join(ROOT, 'tools', 'tracker_log.py'))
tl = importlib.util.module_from_spec(tspec); tspec.loader.exec_module(tl)
nw = tl.make_event('a03', 'NEW', {'status': 'open', 'title': 'C', 'court': 'Harsh', 'updated': '2026-11-01T00:00:00Z', 'log': []}, '2026-11-01T00:00:00Z')
st = tl.make_event('a03', 'SET', {'status': 'done'}, '2026-11-20T18:47:00Z')
rr = tl.replay(nw + '\n' + st + '\n')[0]
txt, cnt = bl.build_live(rr, datetime.datetime(2026, 11, 20, 20, 0, tzinfo=bl.PT), 'fp')
check('closed row with derived updated lands in DONE TODAY', cnt['done'] == 1 and 'a03' in txt, txt)
check('LIVE LIST has no em dash', '\u2014' not in txt)

check('Custom_Field__c and __init__ survive', nx({'log': [{'t': 'Set Custom_Field__c on __init__ now'}]}) == 'Set Custom_Field__c on __init__ now', nx({'log': [{'t': 'Set Custom_Field__c on __init__ now'}]}))
nw2 = tl.make_event('a04', 'NEW', {'status': 'done', 'title': 'D', 'court': 'Harsh', 'updated': '2026-11-17T00:00:00Z', 'log': []}, '2026-11-17T00:00:00Z')
lg2 = tl.make_event('a04', 'LOG', {'d': '2026-11-20', 't': 'reopened note'}, '2026-11-20T18:00:00Z')
r2 = tl.replay(nw2 + '\n' + lg2 + '\n')[0]
t2, c2 = bl.build_live(r2, datetime.datetime(2026, 11, 20, 20, 0, tzinfo=bl.PT), 'fp')
check('an old done row with a LOG today reappears in DONE TODAY', c2['done'] == 1, t2)
q = '[unreviewed, auto b1] ' + 'w' * 300
check('quarantine tag stays in front of its text in next:', nx({'log': [{'t': q}]}).startswith('[unreviewed, auto b1] w'))
print('\n' + ('ALL PASS' if not fails else '%d FAILED' % fails))
sys.exit(1 if fails else 0)
