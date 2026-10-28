#!/usr/bin/env python3
"""One generator for the Sidekick context pack and the brief's LIVE LIST block.

The tracker is the single source of truth. This script only transforms local files;
the Claude session running it does every connector call (see tools/RUNBOOK.md).
No work data lives in this public repo: tracker items, the static pack blocks
(me / voice / people / stories) and the brief all come in as files at run time.

Subcommands
  static <old_pack> <static.json>
      <old_pack> = the current Drive pack, as raw JSON or as the base64 "content" string from
      download_file_content (a file holding just that string). Only the part before "items"
      is needed, so a copy clipped after the "items" key still works.
      writes static.json = {"source","me","voice","people","stories"} unchanged.
  build <export_dir> <static.json> <out_dir>
      export_dir : tracker export (flat <id>.json files, or a dir holding items/)
      static.json: {"source", "me", "voice", "people", "stories"} carried into the pack
      writes out_dir/sidekick-pack.json  (pure ASCII, one value per line, so byte count = character count)
             out_dir/live_list.txt       (the brief block, sentinel line last)
             out_dir/meta.json           (fingerprint, counts, byte size, md5)
  doc-plan <read_doc.json> <out_dir>
      reads a Google Docs read_doc result (saved to a file) and out_dir/live_list.txt,
      writes out_dir/doc_requests.json ({"documentId"?, "requests", "writeControl"})
      and prints {"action": "write"|"skip", ...}. Exit 2 = refuse (stop the run).
  verify-doc <read_doc.json> <out_dir>
      exit 0 only if the brief's block now equals out_dir/live_list.txt exactly.
  verify-pack <downloaded> <out_dir>
      <downloaded> = raw pack JSON, or a download_file_content result ({"content": base64}).
      exit 0 only if it parses and its items equal the local pack's items.
"""
import base64, datetime, glob, hashlib, json, os, sys
from zoneinfo import ZoneInfo

PT = ZoneInfo('America/Los_Angeles')
HEAD = 'CURRENT STATE'
LIVE = 'LIVE LIST,'
STOP = 'UPDATE about'
SENTINEL = 'END LIVE LIST'
FP_TAG = 'fingerprint '


def now_pt():
    return datetime.datetime.now(PT)


def clean(s):
    s = ' '.join((s or '').split())
    return s.replace(' — ', ', ').replace('—', ', ').replace('–', '-')


def clip(s, n):
    s = ' '.join((s or '').split())
    return s if len(s) <= n else s[:n - 3].rstrip() + '...'


def pt_date(iso):
    """Tracker 'updated' is UTC ISO (or a plain date). Return the Pacific date."""
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


def load_items(src):
    if os.path.isdir(os.path.join(src, 'items')):
        src = os.path.join(src, 'items')
    out = {}
    for f in sorted(glob.glob(os.path.join(src, '*.json'))):
        d = json.load(open(f, encoding='utf-8'))
        if isinstance(d.get('data'), dict):  # tolerate a wrapped export
            d = d['data']
        out[os.path.splitext(os.path.basename(f))[0]] = d
    if not out:
        sys.exit('no tracker item files in ' + src)
    return out


# ---------- pack ----------
def build_pack(items, static, today):
    """items = open/waiting, plus done items updated within 2 days (Pacific dates).
    Parked items stay out. Each item keeps its last 5 log lines clipped to 460 chars."""
    rows = []
    for key in sorted(items):
        d = items[key]
        st = d.get('status')
        if st == 'done':
            upd = pt_date(d.get('updated'))
            if upd is None or (today - upd).days > 2:
                continue
        elif st not in ('open', 'waiting'):
            continue
        log = d.get('log') or []
        rows.append({
            'id': key,
            'title': d.get('title') or '',
            'key': d.get('key') or '',
            'status': st or '',
            'court': d.get('court') or '',
            'owner': d.get('owner') or '',
            'due': d.get('due') or '',
            'chase': d.get('chase') or '',
            'group': d.get('group') or '',
            'done_when': d.get('quality') or '',
            'log': [{'d': l.get('d', ''), 't': clip(l.get('t'), 460)} for l in log[-5:]],
        })
    return {
        'built': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC'),
        'source': static.get('source', 'CMCM Activity Tracker'),
        'me': static['me'],
        'voice': static['voice'],
        'people': static['people'],
        'stories': static['stories'],
        'items': rows,
    }


# ---------- live list ----------
def next_weekday(d):
    d += datetime.timedelta(days=1)
    while d.weekday() >= 5:
        d += datetime.timedelta(days=1)
    return d


def fmt_day(d):
    return d.strftime('%a %-d %b')


def is_harsh(court):
    c = (court or '').strip().lower()
    return c == '' or c.startswith('harsh')


def line(key, d):
    log = d.get('log') or []
    nxt = clip(clean(log[-1].get('t')), 160) if log else 'no log yet'
    return '%s %s (court: %s; next: %s)' % (key, clean(d.get('title')), clean(d.get('court')) or 'Harsh', nxt)


def build_live(items, now, fp):
    today = now.date()
    tom = next_weekday(today)
    t_s, tom_s = today.isoformat(), tom.isoformat()
    sec = {'today': [], 'tom': [], 'wait': [], 'done': []}
    later = []

    def sk(kd):
        k, d = kd
        ds = [x for x in (d.get('due'), d.get('chase')) if x]
        return (min(ds) if ds else '9999', k)

    for key, d in sorted(items.items(), key=sk):
        st = d.get('status')
        if st == 'done':
            if pt_date(d.get('updated')) == today:
                sec['done'].append(line(key, d))
            continue
        if st not in ('open', 'waiting'):
            continue  # parked and anything else stays off the list
        dates = [x[:10] for x in (d.get('due'), d.get('chase')) if x]
        if any(x <= t_s for x in dates):
            sec['today'].append(line(key, d))
        elif any(x == tom_s for x in dates):
            sec['tom'].append(line(key, d))
        elif not is_harsh(d.get('court')):
            sec['wait'].append(line(key, d))
        else:
            later.append(key)

    stamp = now.strftime('%a %-d %b %Y %-I:%M %p')
    out = ['LIVE LIST, generated %s Pacific from the tracker (%s%s). Auto-generated; change the tracker, not this block.' % (stamp, FP_TAG, fp)]
    for title, k in (('TODAY (%s, due or chase today or overdue)' % fmt_day(today), 'today'),
                     ('TOMORROW (%s)' % fmt_day(tom), 'tom'),
                     ('WAITING ON OTHERS', 'wait'),
                     ('DONE TODAY', 'done')):
        out.append('%s: %d' % (title, len(sec[k])))
        out.extend(sec[k] or ['none'])
    out.append('ALSO OPEN ON HARSH, no date soon: %s' % (', '.join(later) if later else 'none'))
    out.append(SENTINEL)
    counts = {k: len(v) for k, v in sec.items()}
    counts['later'] = len(later)
    return '\n'.join(out) + '\n', counts


def fingerprint(items, today):
    blob = json.dumps(items, sort_keys=True, ensure_ascii=False) + today.isoformat()
    return hashlib.sha256(blob.encode('utf-8')).hexdigest()[:12]


def cmd_static(old_path, static_path):
    raw = open(old_path, 'rb').read().strip()
    if not raw.startswith(b'{'):
        s = raw.decode('ascii', 'ignore')
        s = ''.join(s.split()).strip('"')
        raw = base64.b64decode(s + '=' * (-len(s) % 4))
    t = raw.decode('utf-8', 'replace')
    try:
        d = json.loads(t)
    except ValueError:
        i = t.find(',"items":')
        if i < 0:
            sys.exit('old pack: cannot find the "items" key')
        d = json.loads(t[:i] + '}')
    out = {'source': d.get('source', 'CMCM Activity Tracker')}
    for k in ('me', 'voice', 'people', 'stories'):
        if k not in d:
            sys.exit('old pack missing "%s"' % k)
        out[k] = d[k]
    json.dump(out, open(static_path, 'w', encoding='utf-8'), ensure_ascii=False)
    print(json.dumps({'ok': True, 'people': len(out['people']), 'stories': len(out['stories'])}))


def cmd_build(export_dir, static_path, out_dir):
    items = load_items(export_dir)
    static = json.load(open(static_path, encoding='utf-8'))
    for k in ('me', 'voice', 'people', 'stories'):
        if k not in static:
            sys.exit('static file missing "%s"' % k)
    now = now_pt()
    fp = fingerprint(items, now.date())
    pack = build_pack(items, static, now.date())
    os.makedirs(out_dir, exist_ok=True)
    pack_path = os.path.join(out_dir, 'sidekick-pack.json')
    # indent=0: one value per line, so the file can be Read and copied into create_file safely
    raw = (json.dumps(pack, ensure_ascii=True, indent=0, separators=(',', ':')) + '\n').encode('ascii')
    open(pack_path, 'wb').write(raw)
    text, counts = build_live(items, now, fp)
    if '—' in text:
        sys.exit('em dash left in live list')
    open(os.path.join(out_dir, 'live_list.txt'), 'w', encoding='utf-8').write(text)
    meta = {'fingerprint': fp, 'tracker_items': len(items), 'pack_items': len(pack['items']),
            'pack_bytes': len(raw), 'pack_md5': hashlib.md5(raw).hexdigest(),
            'sections': counts, 'generated_pt': now.isoformat(timespec='minutes')}
    json.dump(meta, open(os.path.join(out_dir, 'meta.json'), 'w'), indent=1)
    print(json.dumps(meta))


# ---------- Google Doc helpers ----------
def load_doc(path):
    d = json.load(open(path, encoding='utf-8'))
    if isinstance(d, list):  # some tool results arrive as [{"type":"text","text":"{...}"}]
        d = json.loads(d[0]['text'])
    d = d.get('content', d)
    if 'tabs' in d:
        body = d['tabs'][0]['documentTab']['body']['content']
    else:
        body = d['body']['content']
    paras = []
    for el in body:
        if 'paragraph' in el:
            t = ''.join(r.get('textRun', {}).get('content', '') for r in el['paragraph']['elements'])
            paras.append((el['startIndex'], el['endIndex'], t))
    return d.get('documentId'), d.get('revisionId'), paras


def locate(paras):
    """Return (mode, start, end, n_paras, sentinel_found, old_text)."""
    h = next((i for i, p in enumerate(paras) if p[2].lstrip().startswith(HEAD)), None)
    if h is None:
        raise SystemExit(2)
    i = h + 1
    while i < len(paras) and not paras[i][2].lstrip().startswith(HEAD):
        if paras[i][2].lstrip().startswith(LIVE):
            start = paras[i][0]
            j = i
            while j < len(paras):
                t = paras[j][2].strip()
                if t == SENTINEL:
                    seg = paras[i:j + 1]
                    return 'replace', start, paras[j][1], len(seg), True, ''.join(p[2] for p in seg)
                if j > i and (t.startswith(STOP) or t.startswith(HEAD)):
                    seg = paras[i:j]
                    return 'replace', start, paras[j][0], len(seg), False, ''.join(p[2] for p in seg)
                j += 1
            raise SystemExit(2)
        i += 1
    return 'insert', paras[h][1], paras[h][1], 0, False, ''


def cmd_doc_plan(doc_path, out_dir):
    new = open(os.path.join(out_dir, 'live_list.txt'), encoding='utf-8').read()
    meta = json.load(open(os.path.join(out_dir, 'meta.json')))
    doc_id, rev, paras = load_doc(doc_path)
    try:
        mode, start, end, n, sent, old = locate(paras)
    except SystemExit:
        print(json.dumps({'action': 'refuse', 'why': 'no CURRENT STATE heading, or LIVE LIST with no end marker'}))
        sys.exit(2)
    if mode == 'replace' and not sent and n > 3:
        print(json.dumps({'action': 'refuse', 'why': 'hand-written LIVE LIST spans %d paragraphs; not deleting that much without the END LIVE LIST marker' % n}))
        sys.exit(2)
    if FP_TAG + meta['fingerprint'] + ')' in old:
        print(json.dumps({'action': 'skip', 'why': 'tracker unchanged since the last publish today', 'fingerprint': meta['fingerprint']}))
        return
    reqs = []
    if mode == 'replace':
        reqs.append({'deleteContentRange': {'range': {'startIndex': start, 'endIndex': end}}})
    reqs.append({'insertText': {'location': {'index': start}, 'text': new}})
    plan = {'documentId': doc_id, 'requests': reqs, 'writeControl': {'requiredRevisionId': rev}}
    json.dump(plan, open(os.path.join(out_dir, 'doc_requests.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps({'action': 'write', 'mode': mode, 'start': start, 'end': end, 'old_paragraphs': n,
                      'old_had_marker': sent, 'old_first_line': old.split('\n')[0][:120], 'revisionId': rev}))


def cmd_verify_doc(doc_path, out_dir):
    new = open(os.path.join(out_dir, 'live_list.txt'), encoding='utf-8').read()
    _, _, paras = load_doc(doc_path)
    mode, start, end, n, sent, old = locate(paras)
    ok = mode == 'replace' and sent and old == new
    print(json.dumps({'ok': ok, 'paragraphs': n, 'first_lines': old.split('\n')[:3]}))
    sys.exit(0 if ok else 1)


def cmd_verify_pack(dl_path, out_dir):
    raw = open(dl_path, 'rb').read()
    try:
        remote = json.loads(raw)
        if isinstance(remote, dict) and 'content' in remote and 'items' not in remote:
            remote = json.loads(base64.b64decode(remote['content']))
    except Exception as e:
        print(json.dumps({'ok': False, 'why': 'parse failed: %s' % e}))
        sys.exit(1)
    local = json.load(open(os.path.join(out_dir, 'sidekick-pack.json'), encoding='utf-8'))
    ok = remote.get('items') == local['items'] and remote.get('people') == local['people']
    print(json.dumps({'ok': ok, 'remote_items': len(remote.get('items', [])), 'local_items': len(local['items']),
                      'built': remote.get('built')}))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    a = sys.argv[1:]
    cmds = {'static': (cmd_static, 2), 'build': (cmd_build, 3), 'doc-plan': (cmd_doc_plan, 2), 'verify-doc': (cmd_verify_doc, 2),
            'verify-pack': (cmd_verify_pack, 2)}
    if not a or a[0] not in cmds or len(a) - 1 != cmds[a[0]][1]:
        sys.exit(__doc__)
    cmds[a[0]][0](*a[1:])
