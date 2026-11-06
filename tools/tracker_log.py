#!/usr/bin/env python3
"""CMCM Activity Tracker as an append-only event log (6 Nov 2026).

Why: the tracker moved off claude.ai (Harsh, 6 Nov: do not build on Claude artifacts or memory).
Drive files cannot be edited in place, so a JSON file would be rewritten whole on every write
(117-335 KB). A Google Doc takes a cheap insertText at the end, so the tracker is a Doc holding
one JSON event per line, and readers replay it into the per-row files build_live.py already reads.
Log lines are appends, so a write can never wipe a row's history (4 Nov incident class).

Event line (one per paragraph; any line not starting with "{" is a comment and is ignored):
  {"v":1,"e":"<id>","ts":"<UTC ISO>","id":"<row>","op":"NEW","row":{...full row...}}
  {"v":1,"e":"<id>","ts":"<UTC ISO>","id":"<row>","op":"SET","set":{"field":value,...}}
  {"v":1,"e":"<id>","ts":"<UTC ISO>","id":"<row>","op":"LOG","log":{"d":"YYYY-MM-DD","t":"..."}}
"e" is a content hash: a line appended twice is applied once.

Subcommands (all local; the Claude session does the Drive/Docs calls, see tools/RUNBOOK.md)
  seed <export_dir> <out.txt> [active|all]
      export_dir = an ArtifactData out_dir export (items/<id>.json). Writes NEW lines.
      active = open/waiting rows, done rows updated in the last 3 days (Pacific), Platform facts.
  replay <log> [<log> ...] <out_dir>
      each <log> = a text/plain export (the live Doc, or a frozen seed file), raw or as the
      base64 "content" string from download_file_content. Logs are replayed in the order given:
      seed files first (cmcm-tracker-seed-1..N), the live cmcm-tracker Doc last.
      Writes out_dir/items/<id>.json and prints meta. Exit 2 = refuse.
  event <row> <op> <json> [ts]
      prints one event line (op NEW|SET|LOG) ready to append.
  append <log> <row> <op> <json> [ts]
      the ONE way to write: builds the event, replays the whole log plus the new line, and
      only if that succeeds appends the line to <log> (file untouched on any refusal).
      The caller then commits and pushes the repo (see tools/RUNBOOK.md, Writing).
  diff <export_dir> <replayed_dir> [active|all]
      exit 0 only if every selected export row equals its replayed row exactly.
"""
import base64, datetime, glob, hashlib, json, os, sys
from zoneinfo import ZoneInfo

PT = ZoneInfo('America/Vancouver')
OPS = ('NEW', 'SET', 'LOG')
COMPACT_AT = 800000  # bytes; Google Docs top out near 1 M characters


def die(msg, code=2):
    print(json.dumps({'ok': False, 'error': msg}))
    sys.exit(code)


def dumps(o):
    return json.dumps(o, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def make_event(row, op, payload, ts=None):
    if op not in OPS:
        die('bad op ' + op)
    ts = ts or datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    key = {'NEW': 'row', 'SET': 'set', 'LOG': 'log'}[op]
    if op == 'SET' and 'log' in payload:
        die('SET may not replace log; use LOG')
    if op == 'LOG' and not (isinstance(payload, dict) and payload.get('t')):
        die('LOG needs {"d","t"}')
    body = dumps({'id': row, 'op': op, key: payload, 'ts': ts})
    ev = {'v': 1, 'e': hashlib.sha256(body.encode('utf-8')).hexdigest()[:12], 'ts': ts, 'id': row, 'op': op, key: payload}
    return dumps(ev)


def load_export(src):
    if os.path.isdir(os.path.join(src, 'items')):
        src = os.path.join(src, 'items')
    out = {}
    for f in sorted(glob.glob(os.path.join(src, '*.json'))):
        d = json.load(open(f, encoding='utf-8'))
        if isinstance(d.get('data'), dict):
            d = d['data']
        out[os.path.splitext(os.path.basename(f))[0]] = d
    if not out:
        die('no rows in ' + src)
    return out


def pacific_date(iso):
    if not iso:
        return None
    try:
        if len(iso) <= 10:
            return datetime.date.fromisoformat(iso)
        dt = datetime.datetime.fromisoformat(iso.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return dt.astimezone(PT).date()
    except ValueError:
        return None


def selected(rows, scope, today=None):
    if scope == 'all':
        return sorted(rows)
    today = today or datetime.datetime.now(PT).date()
    keep = []
    for k in sorted(rows):
        d = rows[k]
        st = d.get('status')
        u = pacific_date(str(d.get('updated') or ''))
        if (d.get('group') or '').lower() == 'platform facts' or st in ('open', 'waiting') \
                or (st == 'done' and u and (today - u).days <= 3):
            keep.append(k)
    return keep


def read_log_text(path):
    raw = open(path, 'rb').read()
    s = raw.strip()
    if s and not s.lstrip(b'\xef\xbb\xbf').startswith((b'{', b'#')):
        try:  # base64 "content" string from download_file_content
            raw = base64.b64decode(s.strip(b'"'), validate=False)
        except Exception:
            pass
    return raw.decode('utf-8-sig')


def replay(text):
    rows, seen, n = {}, set(), 0
    for i, line in enumerate(text.splitlines(), 1):
        line = line.strip().lstrip('﻿')
        if not line.startswith('{'):
            continue
        try:
            ev = json.loads(line)
        except ValueError as ex:
            die('line %d is not valid JSON: %s' % (i, ex))
        e, rid, op = ev.get('e'), ev.get('id'), ev.get('op')
        if not (e and rid and op in OPS):
            die('line %d missing e/id/op' % i)
        if e in seen:
            continue
        seen.add(e)
        n += 1
        if op == 'NEW':
            if not isinstance(ev.get('row'), dict):
                die('line %d NEW without row' % i)
            rows[rid] = json.loads(json.dumps(ev['row']))
        elif rid not in rows:
            die('line %d %s on unknown row %s' % (i, op, rid))
        elif op == 'SET':
            s = ev.get('set') or {}
            if 'log' in s:
                die('line %d SET replaces log' % i)
            rows[rid].update(s)
        else:
            rows[rid].setdefault('log', []).append(ev.get('log'))
    if not rows:
        die('no rows in the log')
    return rows, n


def cmd_seed(export_dir, out, scope='active'):
    rows = load_export(export_dir)
    keys = selected(rows, scope)
    ts = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    lines = ['# cmcm-tracker event log v1. One JSON event per line (NEW/SET/LOG). Append only; never edit or delete a line. Replay: tools/tracker_log.py in harsharma27/sidekick. Seeded %s (%s, %d rows).' % (ts, scope, len(keys))]
    lines += [make_event(k, 'NEW', rows[k], ts) for k in keys]
    text = '\n'.join(lines) + '\n'
    open(out, 'w', encoding='utf-8').write(text)
    print(json.dumps({'ok': True, 'rows': len(keys), 'bytes': len(text.encode('utf-8')), 'chars': len(text)}))


def cmd_replay(*args):
    *logs, out_dir = args
    text = '\n'.join(read_log_text(p) for p in logs)
    rows, n = replay(text)
    d = os.path.join(out_dir, 'items')
    os.makedirs(d, exist_ok=True)
    for k, v in rows.items():
        json.dump(v, open(os.path.join(d, k + '.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    size = len(text.encode('utf-8'))
    print(json.dumps({'ok': True, 'logs': len(logs), 'rows': len(rows), 'events': n, 'bytes': size, 'compact_due': size >= COMPACT_AT}))


def cmd_event(row, op, js, ts=None):
    print(make_event(row, op, json.loads(js), ts))


def cmd_append(log_path, row, op, js, ts=None):
    line = make_event(row, op, json.loads(js), ts)
    text = read_log_text(log_path) if os.path.exists(log_path) else ''
    if text and not text.endswith('\n'):
        text += '\n'
    rows, n = replay(text + line + '\n')  # dies (exit 2) before anything is written
    with open(log_path, 'a', encoding='utf-8') as f:
        if text and not open(log_path, encoding='utf-8').read().endswith('\n'):
            f.write('\n')
        f.write(line + '\n')
    print(json.dumps({'ok': True, 'row': row, 'op': op, 'e': json.loads(line)['e'], 'rows': len(rows), 'events': n}))


def cmd_diff(export_dir, replayed, scope='active'):
    a, b = load_export(export_dir), load_export(replayed)
    keys = selected(a, scope)
    bad = [k for k in keys if a[k] != b.get(k)]
    extra = sorted(set(b) - set(keys))
    print(json.dumps({'ok': not bad and not extra, 'checked': len(keys), 'mismatch': bad[:20], 'extra': extra[:20]}))
    sys.exit(0 if not bad and not extra else 1)


if __name__ == '__main__':
    a = sys.argv[1:]
    cmds = {'seed': (cmd_seed, 2, 3), 'replay': (cmd_replay, 2, 40), 'event': (cmd_event, 3, 4), 'append': (cmd_append, 4, 5), 'diff': (cmd_diff, 2, 3)}
    if not a or a[0] not in cmds or not cmds[a[0]][1] <= len(a) - 1 <= cmds[a[0]][2]:
        sys.exit(__doc__)
    cmds[a[0]][0](*a[1:])
