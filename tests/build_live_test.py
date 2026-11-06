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
print('\n' + ('ALL PASS' if not fails else '%d FAILED' % fails))
sys.exit(1 if fails else 0)
