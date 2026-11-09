#!/usr/bin/env python3
"""Static checks for the work-lane change to live.html (9 Nov 2026, hub review 2026-11-09-sidekick-door). No browser, no network.
Run: python3 -I tests/lane_static_test.py (repo root). The browser behaviour is in tests/lane_test.js."""
import json, os, re, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
live = open(os.path.join(ROOT, 'live.html'), encoding='utf-8').read()
fails = 0
def check(name, ok, detail=''):
    global fails
    print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '\n  ' + str(detail))); fails += 0 if ok else 1

# rendering stays textContent
check('innerHTML count stays 0 (live.html)', live.count('innerHTML') == 0, live.count('innerHTML'))
check('no other HTML sinks (outerHTML, insertAdjacentHTML, document.write)', not re.search(r'outerHTML|insertAdjacentHTML|document\.write', live))
check('textContent is used for rendering (48 before this change)', live.count('textContent') >= 48, live.count('textContent'))

# CSP
m = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)"', live)
csp = {}
if m:
    for part in m.group(1).split(';'):
        bits = part.split()
        if bits: csp[bits[0]] = bits[1:]
check('a CSP meta tag exists', bool(m))
conn = csp.get('connect-src', [])
check('connect-src has the gate host and api.anthropic.com', 'https://hub.taile4cbbe.ts.net:8444' in conn and 'https://api.anthropic.com' in conn, conn)
check("connect-src has no wildcard, no http:, no data:, no bare *", not any(x in ('*', 'http:', 'https:', 'data:', 'blob:', 'ws:', 'wss:') or '*' in x or x.startswith('http://') for x in conn), conn)
check('connect-src is only: self, the gate, Anthropic, Drive, Google sign-in, OpenRouter', set(conn) <= {"'self'", 'https://hub.taile4cbbe.ts.net:8444', 'https://api.anthropic.com', 'https://www.googleapis.com', 'https://accounts.google.com', 'https://openrouter.ai'}, conn)
check("default-src is 'self', objects and base-uri are closed", csp.get('default-src') == ["'self'"] and csp.get('object-src') == ["'none'"] and csp.get('base-uri') == ["'none'"] and csp.get('form-action') == ["'none'"], csp)
urls = set(re.findall(r"""fetch\(\s*(?:GATE\+)?['"]([^'"]+)""", live)) | set(re.findall(r"""fetch\(\s*(https://[^'",)]+)""", live))
hosts = set(re.findall(r"https://[a-z0-9.-]+(?::\d+)?", ' '.join(re.findall(r"fetch\('[^']+'", live) + re.findall(r"fetch\(GATE\+'[^']+'", live) + re.findall(r"sc\.src='[^']+'", live) + re.findall(r"gfetch\('[^']+'", live))))
check("every https host the page fetches is allowed by connect-src or script-src", all(h in conn or h in csp.get('script-src', []) for h in hosts), (hosts, conn))

# the adapter
check('the gate URL is the hub one and /v1/messages is never called on it', "var GATE='https://hub.taile4cbbe.ts.net:8444'" in live and "GATE+'/v1/chat/completions'" in live and "GATE+'/v1/messages'" not in live)
check('the lane request is OpenAI-format with SSE streaming (stream:true, a system MESSAGE, no top-level system)', "stream:true" in live and "messages:[{role:'system',content:sys},{role:'user',content:userText}]" in live)
check('x-sk-fallbacks is an integer metadata header', "'x-sk-fallbacks':String(fbPending)" in live and 'x-hub-retry' not in live.lower())
check('the hub key field is a password input, separate from the Anthropic key', '<input type="password" id="hubkey"' in live and 'id="apikey"' in live)
check("the hub key note names the Sidekick-only Brave profile and localStorage", 'Sidekick-only Brave profile' in live and "localStorage only" in live)
check('the path toggle shows "direct" and "work lane" and defaults to direct', 'id="pathDirect"' in live and '>direct</button>' in live and '>work lane</button>' in live and "path:'direct'" in live and "if(S.path!=='lane') S.path='direct'" in live)
check('the lane never uses the auto router (page allow-list)', "var ALLOWED_GROUPS={'work-fallback':1,'work-sonnet':1}" in live and 'work-auto' not in live and 'work-opus' not in live)
check('fallback is gated on laneTransport only, refusals have their own branch', 'if(lane && e.laneTransport)' in live and 'if(e.refused)' in live and live.index('if(lane && e.laneTransport)') < live.index('if(e.refused)'))
check('a refusal is recognised by "refused:" and mapped to the two wordings', "/refused:/i" in live and "'switched off'" in live and "'blocked by the work-lane rule'" in live)

# routing.json
r = json.load(open(os.path.join(ROOT, 'routing.json')))
dm = re.search(r"var DEFAULT_ROUTING=(\{.*?\});\n", live)
check('routing.json equals the built-in copy in live.html', dm and json.loads(dm.group(1)) == r, 'drift')
check('aimed-at-me detection = work-fallback; answers and wrap = work-sonnet', r['tasks']['detect']['group'] == 'work-fallback' and r['tasks']['answer']['group'] == 'work-sonnet' and r['tasks']['wrap']['group'] == 'work-sonnet' and r['default']['group'] == 'work-sonnet')
groups = {r['default']['group']} | {t['group'] for t in r['tasks'].values()}
check('only work-fallback and work-sonnet appear', groups <= {'work-fallback', 'work-sonnet'}, groups)
check('every task has a first-byte deadline and max tokens', all(isinstance(t.get('first_byte_ms'), int) and isinstance(t.get('max_tokens'), int) for t in list(r['tasks'].values()) + [r['default']]))
tasks_used = set(re.findall(r"task:'([a-z]+)'", live))
check('every task the page names is in routing.json', tasks_used <= set(r['tasks']), tasks_used - set(r['tasks']))

# no key-shaped string anywhere in the repo
files = subprocess.run(['git', 'ls-files', '-co', '--exclude-standard'], cwd=ROOT, capture_output=True, text=True).stdout.split()
shapes = [r'sk-[A-Za-z0-9_-]{16,}', r'gh[pousr]_[A-Za-z0-9]{20,}', r'github_pat_[A-Za-z0-9_]{20,}', r'AKIA[0-9A-Z]{16}', r'xox[abprs]-[A-Za-z0-9-]{10,}', r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}', r'Bearer [A-Za-z0-9._-]{20,}', r'-----BEGIN [A-Z ]*PRIVATE KEY-----']
bad = []
for f in files:
    p = os.path.join(ROOT, f)
    if not os.path.isfile(p) or f.endswith(('.png', '.jpg', '.xlsx', '.patch')): continue
    t = open(p, encoding='utf-8', errors='replace').read()
    for rx in shapes:
        if re.search(rx, t): bad.append((f, rx))
    for tok in re.findall(r'[A-Za-z0-9_-]{32,}', t):
        if re.fullmatch(r'1[A-Za-z0-9_-]{32}|1[A-Za-z0-9_-]{43}', tok): continue   # a Google Drive file/folder id (public identifiers already in the repo, not credentials)
        if re.search(r'[a-z]', tok) and re.search(r'[A-Z]', tok) and re.search(r'[0-9]', tok): bad.append((f, 'mixed-case token of %d chars' % len(tok)))
check('no key-shaped string in any repo file (%d files)' % len(files), not bad, bad)
check('the page stores no default key (hubkey/apikey start empty)', "hubkey:''" in live and "apikey:''" in live)
print('\n' + ('ALL PASS' if not fails else '%d FAILED' % fails)); sys.exit(1 if fails else 0)
