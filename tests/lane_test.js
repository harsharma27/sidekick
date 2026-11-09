// Sidekick work-lane regression test (9 Nov 2026, hub review 2026-11-09-sidekick-door). Run from the repo root before committing any live.html or routing.json change:
//   node tests/lane_test.js        (needs playwright; nothing leaves the machine: the gate, Anthropic and Drive are all mocked)
// The gate is mocked inside the page by wrapping fetch for the gate URL (so SSE chunking, delays and aborts are exact); the CSP is checked for real against a request
// to a host that is not allowed. Keys below are throwaway test strings.
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'live.html'), 'utf8');
const patches = [[' if(!OK.test(ev.origin)) return;', ' ']];   // the Teams origin check only; Drive is NOT patched (test mode must block it for real)
for (const [from, to] of patches) {
  const n = html.split(from).length - 1;
  if (n !== 1) { console.log(`FAIL harness: expected 1 match for ${JSON.stringify(from)}, found ${n}`); process.exit(1); }
  html = html.replace(from, to);
}
let routing = fs.readFileSync(path.join(ROOT, 'routing.json'), 'utf8');
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/harness.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); }
  else if (u === '/routing.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(routing); }
  else { res.writeHead(404); res.end(); }
});
const HUBKEY = 'hub' + '-test-' + 'key', GATE = 'https://hub.taile4cbbe.ts.net:8444';
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

// runs in the page before any script: the mocked gate
function initGate() {
  const GATE_URL = 'https://hub.taile4cbbe.ts.net:8444';
  const g = window.__gate = { log: [], plan: [], default: 'ok' };
  const realFetch = window.fetch.bind(window);
  const enc = new TextEncoder();
  const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
  const chunkObj = (text, extra) => Object.assign({ model: 'anthropic/claude-sonnet-5.5', choices: [{ delta: { content: text } }] }, extra || {});
  function streamOf(pieces, opts) {   // pieces: strings emitted one by one with a small delay; opts.breakAfterFirst throws after the first piece
    let i = 0;
    return new ReadableStream({
      async pull(ctl) {
        await new Promise(r => setTimeout(r, 20));
        if (i >= pieces.length) { ctl.close(); return; }
        ctl.enqueue(enc.encode(pieces[i++]));
        if (opts && opts.breakAfterFirst && i === 1) { await new Promise(r => setTimeout(r, 20)); ctl.error(new TypeError('network error mid-stream')); }
      }
    });
  }
  function okResponse(model, opts) {
    const text = 'LANE:' + model, pieces = (opts && opts.pieces) || [sse(chunkObj(text.slice(0, 5))), sse(chunkObj(text.slice(5), { choices: [{ delta: { content: text.slice(5) }, finish_reason: 'stop' }] })), sse({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), 'data: [DONE]\n\n'];
    return new Response(streamOf(pieces, opts), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  const json = (status, obj, headers) => new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
  window.fetch = function (url, opts) {
    url = String(url);
    if (!url.startsWith(GATE_URL)) return realFetch(url, opts);
    opts = opts || {};
    const body = opts.body ? JSON.parse(opts.body) : null;
    const rec = { url, method: opts.method || 'GET', auth: (opts.headers || {}).authorization, fallbacks: (opts.headers || {})['x-sk-fallbacks'], hasAnthropicKey: !!(opts.headers || {})['x-api-key'], body };
    g.log.push(rec);
    const mode = g.plan.length ? g.plan.shift() : (url.endsWith('/v1/models') ? 'ok' : g.default);   // the probe is a GET: only a planned mode changes it
    rec.mode = mode;
    return new Promise((resolve, reject) => {
      const sig = opts.signal; if (sig) sig.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      const model = body && body.model;
      if (url.endsWith('/v1/models')) {
        if (mode === 'network') return reject(new TypeError('Failed to fetch'));
        if (mode === 'models502') return resolve(json(502, { error: 'bad gateway' }));
        if (mode === 'models401') return resolve(json(401, { error: 'unauthorized' }));
        if (mode === 'slowfirst') return;   // never answers: the probe deadline aborts it
        return resolve(json(200, { data: [{ id: 'work-fallback' }, { id: 'work-sonnet' }] }));
      }
      switch (mode) {
        case 'ok': return resolve(okResponse(model));
        case 'detect-no': return resolve(model === 'work-fallback' ? okResponse(model, { pieces: [sse(chunkObj('{"for_me": false, "kind": "", "ask": ""}')), 'data: [DONE]\n\n'] }) : okResponse(model));
        case 'split': return resolve(okResponse(model, { pieces: ['data: {"model":"m","choices":[{"delta":{"con', 'tent":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo wr', 'ap world"},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'] }));
        case 'plain': return resolve(json(200, { model: 'm', choices: [{ message: { content: 'PLAIN COMPLETION' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
        case 'network': return reject(new TypeError('Failed to fetch'));
        case 'http502': return resolve(json(502, { error: 'bad gateway' }));
        case 'http504': return resolve(json(504, { error: 'gateway timeout' }));
        case 'http503plain': return resolve(json(503, { error: { message: 'upstream unavailable' } }));
        case 'http503refused': return resolve(json(503, { error: { message: 'refused: spend cannot be read, so the cap cannot be checked' } }));
        case 'refused-client': return resolve(json(400, { error: { message: 'refused: the prompt names a client (domain-lululemon) - nothing was sent' } }));
        case 'refused-kill': return resolve(json(429, { error: { message: 'refused: the sidekick kill switch is on (manual) - bin/door-ctl.sh status' } }));
        case 'refused-cap': return resolve(json(429, { error: { message: 'refused: the sidekick monthly cap (5 USD) is reached and the key is switched off' } }));
        case 'refused-500': return resolve(json(500, { error: { message: 'refused: the door could not check this request' } }));
        case 'refused-in-stream': return resolve(okResponse(model, { pieces: [sse({ error: { message: 'refused: the prompt names a client (domain-mastek) - nothing was sent' } })] }));
        case 'rate429': return resolve(json(429, { error: 'rate limited' }, { 'retry-after': '1' }));
        case 'http401': return resolve(json(401, { error: 'unauthorized' }));
        case 'http403origin': return resolve(json(403, { error: 'origin not allowed' }));
        case 'break-mid': return resolve(okResponse(model, { breakAfterFirst: true }));
        case 'slowfirst': return;   // no header, no byte: only the first-byte deadline ends it
        case 'slowbody': return resolve(new Response(new ReadableStream({ start(ctl) { if (sig) sig.addEventListener('abort', () => ctl.error(new DOMException('aborted', 'AbortError'))); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));   // headers but no byte
        default: return reject(new Error('unknown mock mode ' + mode));
      }
    });
  };
}

async function newPage(browser, o) {
  o = o || {};
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errors = []; p.errors = errors;
  p.on('pageerror', e => errors.push(e.message));
  p.on('dialog', d => d.accept());
  p.anth = [];
  await p.route('https://api.anthropic.com/**', async r => {
    p.anth.push(r.request().url());
    await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ model: 'direct-model', stop_reason: 'end_turn', content: [{ type: 'text', text: o.directText || 'DIRECT WRAP' }], usage: { input_tokens: 1, output_tokens: 1 } }) });
  });
  const stored = Object.assign({ apikey: 'x', hubkey: HUBKEY, gcid: 'y', gfolder: 'z', names: 'Harsh', mFast: 'f', mSmart: 's', cap: 200 }, o.settings || {});
  if (o.path) stored.path = o.path;
  await p.addInitScript(initGate);
  await p.addInitScript(s => { try { if (!localStorage.getItem('sidekick_live')) localStorage.setItem('sidekick_live', JSON.stringify(s)); } catch (e) {} }, stored);
  if (o.plan) await p.addInitScript(pl => { window.__gate.plan = pl.slice(); }, o.plan);
  if (o.fallback) await p.addInitScript(d => { window.__gate.default = d; }, o.fallback);
  await p.goto(o.url || `http://127.0.0.1:${server.address().port}/harness.html`);
  await p.waitForTimeout(150);
  return p;
}
const gateLog = p => p.evaluate(() => window.__gate.log.slice());
const feed = (p, caps) => p.evaluate(c => window.postMessage({ sk: 'cap1', caps: c }, '*'), caps);
async function wrap(p, wait) {
  wrap.n = (wrap.n || 0) + 1;
  await feed(p, [{ id: 'a' + wrap.n, author: 'Pat Example', text: 'Synthetic caption number ' + wrap.n + ' about the demo item.' }]);
  await p.waitForTimeout(250);
  await p.click('#wrapBtn');
  await p.waitForTimeout(wait || 900);
  return p.evaluate(() => document.getElementById('wrapOut').textContent);
}
const calls = (log, kind) => log.filter(r => r.url.endsWith(kind));

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch();

  // 1. default is direct: Anthropic is used, the gate is never touched
  let p = await newPage(browser);
  check('Default path is direct (toggle shows direct selected)', await p.evaluate(() => document.getElementById('pathDirect').className === 'on' && document.getElementById('pathLane').className === ''));
  check('Header shows the answering model on the direct path', /Answering: s \(direct\)/.test(await p.textContent('#modelPill')), await p.textContent('#modelPill'));
  let out = await wrap(p);
  check('Direct: wrap answered by Anthropic', out === 'DIRECT WRAP' && p.anth.length === 1, [out, p.anth.length]);
  check('Direct: the gate is never called (no probe either)', (await gateLog(p)).length === 0);
  check('Direct: no page errors', p.errors.length === 0, p.errors);
  await p.context().close();

  // 2. lane wrap: OpenAI format, streaming, group from routing.json, hub key only
  p = await newPage(browser, { path: 'lane' });
  await p.waitForTimeout(200);
  out = await wrap(p);
  let log = await gateLog(p), c = calls(log, '/v1/chat/completions')[0];
  check('Lane: probe GET /v1/models ran at page start with the hub key', calls(log, '/v1/models').length >= 1 && calls(log, '/v1/models')[0].auth === 'Bearer ' + HUBKEY, log.map(r => r.url));
  check('Lane: wrap went to the gate chat-completions as work-sonnet, streaming', c && c.method === 'POST' && c.body.model === 'work-sonnet' && c.body.stream === true, c && c.body);
  check('Lane: OpenAI shape (system MESSAGE first, user second, no top-level system field)', c && c.body.messages[0].role === 'system' && c.body.messages[1].role === 'user' && !('system' in c.body), c && Object.keys(c.body));
  check('Lane: Authorization is the hub key; the Anthropic key header is not sent', c && c.auth === 'Bearer ' + HUBKEY && !c.hasAnthropicKey);
  check('Lane: x-sk-fallbacks is an integer string (0)', c && c.fallbacks === '0', c && c.fallbacks);
  check('Lane: max_tokens comes from routing.json (wrap 4000)', c && c.body.max_tokens === 4000, c && c.body.max_tokens);
  check('Lane: the streamed text is shown; Anthropic is not called', out === 'LANE:work-sonnet' && p.anth.length === 0, [out, p.anth.length]);
  check('Lane: header shows the answering model and the last reply model', /Answering: work-sonnet \(detect: work-fallback\)/.test(await p.textContent('#modelPill')) && /last: anthropic\/claude-sonnet-5\.5/.test(await p.textContent('#modelPill')), await p.textContent('#modelPill'));
  check('Lane: pill says ok with a first-byte time', /Work lane: ok \(work-sonnet, first byte \d+ ms\)/.test(await p.textContent('#lanePill')), await p.textContent('#lanePill'));
  check('Lane: usage pill counts the call', /1 calls today/.test(await p.textContent('#aiPill')), await p.textContent('#aiPill'));
  check('Lane: no page errors', p.errors.length === 0, p.errors);
  await p.context().close();

  // 3. aimed-at-me detection uses work-fallback, then the answer uses work-sonnet
  p = await newPage(browser, { path: 'lane', fallback: 'detect-no' });
  await feed(p, [{ id: 'd1', author: 'Pat Example', text: 'Harsh, can you confirm the synthetic demo item is ready?' }]);
  await p.waitForTimeout(4200);
  log = await gateLog(p);
  check('Detection (aimed at me) went to work-fallback', calls(log, '/v1/chat/completions').some(r => r.body.model === 'work-fallback'), log.map(r => r.body && r.body.model));
  check('Detection max_tokens comes from routing.json (600) and Anthropic is not called', calls(log, '/v1/chat/completions')[0].body.max_tokens === 600 && p.anth.length === 0);
  await p.context().close();
  p = await newPage(browser, { path: 'lane' });   // default mode ok: the detection reply is not JSON, so the page shows the check; the answer path is exercised by the say box
  await p.fill('#sayIn', 'update on the demo item'); await p.click('#sayBtn'); await p.waitForTimeout(900);
  log = await gateLog(p);
  check('Answer ("What should I say?") went to work-sonnet', calls(log, '/v1/chat/completions').some(r => r.body.model === 'work-sonnet'), log.map(r => r.body && r.body.model));
  await p.context().close();

  // 4. streaming: a line split across chunks is reassembled; a plain completion body is accepted
  p = await newPage(browser, { path: 'lane', fallback: 'split' });
  out = await wrap(p);
  check('Stream: SSE lines split across chunks are reassembled', out === 'Hello wrap world', out);
  await p.context().close();
  p = await newPage(browser, { path: 'lane', fallback: 'plain' });
  out = await wrap(p);
  check('Stream: a plain (non-stream) completion body is accepted too', out === 'PLAIN COMPLETION', out);
  await p.context().close();

  // 5. refusals: shown, never retried, never a fallback
  for (const [mode, want, label] of [['refused-client', 'blocked by the work-lane rule', 'client-term refusal (400)'], ['refused-kill', 'switched off', 'kill switch (429)'], ['refused-cap', 'switched off', 'cap reached (429)'],
                                      ['http503refused', 'blocked by the work-lane rule', 'refused 503 (spend unreadable)'], ['refused-500', 'blocked by the work-lane rule', 'refused 500'], ['refused-in-stream', 'blocked by the work-lane rule', 'refusal inside the stream']]) {
    p = await newPage(browser, { path: 'lane', fallback: mode });
    out = await wrap(p, 1200);
    log = await gateLog(p);
    check(`Refusal ${label}: shown as "${want}"`, out.indexOf(want) >= 0, out);
    check(`Refusal ${label}: Anthropic never called, no retry, no fallback banner`, p.anth.length === 0 && calls(log, '/v1/chat/completions').length === 1 && (await p.isHidden('#laneBar')), [p.anth.length, calls(log, '/v1/chat/completions').length]);
    check(`Refusal ${label}: lane pill is bad and stays on the lane`, /bad/.test(await p.getAttribute('#lanePill', 'class')) && await p.evaluate(() => document.getElementById('pathLane').className === 'on'));
    await p.context().close();
  }
  p = await newPage(browser, { path: 'lane', fallback: 'refused-kill' });
  for (let i = 0; i < 4; i++) { await feed(p, [{ id: 'r' + i, author: 'Pat Example', text: 'Another synthetic line ' + i }]); await p.waitForTimeout(100); await p.click('#wrapBtn'); await p.waitForTimeout(500); }
  check('Repeated refusals never trigger the 3-failure pause (the real reason stays visible)', !/PAUSED/.test(await p.textContent('#aiPill')) && /switched off/.test(await p.textContent('#wrapOut')), await p.textContent('#aiPill'));
  await p.context().close();

  // 6. transport failures fall back to direct for the rest of the meeting, visibly
  for (const mode of ['network', 'http502', 'http504', 'http503plain']) {
    p = await newPage(browser, { path: 'lane', plan: [], fallback: mode });
    // the page-start probe is a GET and succeeds; only chat calls fail in these modes
    await p.evaluate(() => { window.__gate.log.length = 0; });
    out = await wrap(p, 1500);
    log = await gateLog(p);
    check(`Transport ${mode}: answered by Anthropic direct`, out === 'DIRECT WRAP' && p.anth.length === 1, [out, p.anth.length]);
    check(`Transport ${mode}: banner names the direct fallback`, !(await p.isHidden('#laneBar')) && /DIRECT/.test(await p.textContent('#laneBar')), await p.textContent('#laneBar'));
    const before = calls(await gateLog(p), '/v1/chat/completions').length;
    await p.click('#wrapBtn'); await p.waitForTimeout(700);
    check(`Transport ${mode}: the rest of the meeting stays direct (no new gate chat call)`, calls(await gateLog(p), '/v1/chat/completions').length === before && p.anth.length === 2, [before, p.anth.length]);
    check(`Transport ${mode}: header shows direct answering while the lane is down`, /direct, work lane down/.test(await p.textContent('#modelPill')), await p.textContent('#modelPill'));
    check(`Transport ${mode}: fallback count stored (1)`, await p.evaluate(() => localStorage.getItem('sidekick_live_fb')) === '1');
    // New call: the lane is tried again and the next door call carries x-sk-fallbacks 1
    await p.evaluate(() => { window.__gate.default = 'ok'; window.__gate.log.length = 0; });
    await p.click('#newCall'); await p.waitForTimeout(400);
    check(`Transport ${mode}: New call hides the banner and probes the hub again`, (await p.isHidden('#laneBar')) && calls(await gateLog(p), '/v1/models').length === 1, calls(await gateLog(p), '/v1/models').length);
    check(`Transport ${mode}: the probe after the fallback carries x-sk-fallbacks 1`, calls(await gateLog(p), '/v1/models')[0].fallbacks === '1', calls(await gateLog(p), '/v1/models')[0].fallbacks);
    out = await wrap(p, 900);
    log = await gateLog(p);
    check(`Transport ${mode}: after New call the lane answers again and the count resets`, out === 'LANE:work-sonnet' && await p.evaluate(() => localStorage.getItem('sidekick_live_fb')) === '0', out);
    check(`Transport ${mode}: no page errors`, p.errors.length === 0, p.errors);
    await p.context().close();
  }

  // 7. first-byte deadline (routing.json: a 1000 ms deadline for wrap) with no header at all, and with headers but no byte
  routing = JSON.stringify(Object.assign(JSON.parse(routing), { tasks: Object.assign(JSON.parse(routing).tasks, { wrap: { group: 'work-sonnet', first_byte_ms: 1000, max_tokens: 3333 } }) }));
  for (const mode of ['slowfirst', 'slowbody']) {
    p = await newPage(browser, { path: 'lane', fallback: mode });
    await p.evaluate(m => { window.__gate.default = m; }, mode);
    out = await wrap(p, 2600);
    check(`Deadline (${mode}): no first byte by the deadline falls back to direct`, out === 'DIRECT WRAP' && p.anth.length === 1, [out, p.anth.length]);
    check(`Deadline (${mode}): routing.json's max_tokens (3333) was in the request`, calls(await gateLog(p), '/v1/chat/completions')[0].body.max_tokens === 3333, calls(await gateLog(p), '/v1/chat/completions')[0].body.max_tokens);
    await p.context().close();
  }
  routing = fs.readFileSync(path.join(ROOT, 'routing.json'), 'utf8');

  // 8. after the first byte a break is NOT a fallback: the same path is retried
  p = await newPage(browser, { path: 'lane', plan: [] });
  await p.evaluate(() => { window.__gate.log.length = 0; window.__gate.plan = ['break-mid', 'ok']; });
  out = await wrap(p, 4200);
  log = await gateLog(p);
  check('Mid-stream break: retried on the lane, no fallback, Anthropic not called', out === 'LANE:work-sonnet' && p.anth.length === 0 && calls(log, '/v1/chat/completions').length === 2 && (await p.isHidden('#laneBar')), [out, p.anth.length, calls(log, '/v1/chat/completions').length]);
  await p.context().close();

  // 9. rate limit and key errors are not transport failures
  p = await newPage(browser, { path: 'lane' });
  await p.evaluate(() => { window.__gate.log.length = 0; window.__gate.plan = ['rate429', 'ok']; });
  out = await wrap(p, 3800);
  check('Gate rate limit (429, not refused): retried on the lane, no fallback', out === 'LANE:work-sonnet' && p.anth.length === 0 && calls(await gateLog(p), '/v1/chat/completions').length === 2, [out, p.anth.length]);
  await p.context().close();
  for (const [mode, want] of [['http401', 'hub key was rejected'], ['http403origin', 'not allowed']]) {
    p = await newPage(browser, { path: 'lane', fallback: mode });
    out = await wrap(p, 1200);
    check(`Gate ${mode}: shown ("${want}"), no fallback, Anthropic not called`, out.indexOf(want) >= 0 && p.anth.length === 0 && (await p.isHidden('#laneBar')), out);
    await p.context().close();
  }

  // 10. toggle and key handling
  p = await newPage(browser, { settings: { hubkey: '' } });
  await p.click('#pathLane'); await p.waitForTimeout(200);
  check('Toggle to work lane without a hub key: refused with a note, stays direct', (await p.evaluate(() => document.getElementById('pathDirect').className === 'on')) && /hub key/.test(await p.textContent('#laneBar')));
  await p.context().close();
  p = await newPage(browser);
  await p.click('#pathLane'); await p.waitForTimeout(400);
  log = await gateLog(p);
  check('Toggle to work lane: switches, persists, and probes GET /v1/models', (await p.evaluate(() => JSON.parse(localStorage.getItem('sidekick_live')).path)) === 'lane' && calls(log, '/v1/models').length === 1 && /reachable \(2 models\)/.test(await p.textContent('#lanePill')), await p.textContent('#lanePill'));
  await p.click('#pathDirect'); await p.waitForTimeout(100);
  check('Toggle back to direct: persisted, pill off', (await p.evaluate(() => JSON.parse(localStorage.getItem('sidekick_live')).path)) === 'direct' && /off/.test(await p.textContent('#lanePill')));
  await p.context().close();
  p = await newPage(browser, { path: 'lane', plan: ['network'] });
  await p.waitForTimeout(300);
  check('Probe failure at page start (transport): banner and direct for the first meeting', !(await p.isHidden('#laneBar')) && /health check/.test(await p.textContent('#laneBar')), await p.textContent('#laneBar'));
  out = await wrap(p, 1000);
  check('Probe failure: the first call goes direct', out === 'DIRECT WRAP' && calls(await gateLog(p), '/v1/chat/completions').length === 0, out);
  await p.context().close();
  p = await newPage(browser, { path: 'lane', plan: ['models401'] });
  await p.waitForTimeout(300);
  check('Probe 401: shown as a key problem, not a fallback', /rejected/.test(await p.textContent('#lanePill')) && (await p.isHidden('#laneBar')), await p.textContent('#lanePill'));
  await p.context().close();
  p = await newPage(browser, { path: 'lane', settings: { hubkey: '' } });
  out = await wrap(p, 500);
  check('Lane selected but no hub key: a clear error, no network call, no silent direct', /hub key/.test(out) && p.anth.length === 0 && (await gateLog(p)).length === 0, out);
  await p.context().close();
  p = await newPage(browser, { path: 'lane', fallback: 'network', settings: { apikey: '' } });
  out = await wrap(p, 1200);
  check('Transport failure with no Anthropic key: says so, never sends anything else', /No Anthropic key/.test(out) && p.anth.length === 0, out);
  await p.context().close();

  // 11. routing.json: invalid content (the auto router, bad numbers) is rejected for the built-in copy; a valid one wins
  routing = JSON.stringify(Object.assign(JSON.parse(routing), { tasks: Object.assign(JSON.parse(routing).tasks, { wrap: { group: 'work-auto', first_byte_ms: 1000, max_tokens: 3333 } }) }));
  p = await newPage(browser, { path: 'lane' });
  await wrap(p, 900);
  check('routing.json naming work-auto is rejected: built-in routes used (work-sonnet, 4000)', calls(await gateLog(p), '/v1/chat/completions')[0].body.model === 'work-sonnet' && calls(await gateLog(p), '/v1/chat/completions')[0].body.max_tokens === 4000);
  await p.context().close();
  routing = fs.readFileSync(path.join(ROOT, 'routing.json'), 'utf8');

  // 12. test mode: synthetic captions through the chosen path, Drive blocked, banner shown
  p = await newPage(browser, { path: 'lane', fallback: 'detect-no', url: `http://127.0.0.1:${server.address().port}/harness.html?test=1` });
  await p.waitForTimeout(8200);
  check('Test mode: banner shown and synthetic captions arrive', !(await p.isHidden('#testBar')) && /TEST MODE/.test(await p.textContent('#testBar')) && parseInt(await p.textContent('#txCount'), 10) >= 2, await p.textContent('#txCount'));
  check('Test mode: the synthetic "Harsh, can you confirm" caption reached the lane (work-fallback)', calls(await gateLog(p), '/v1/chat/completions').some(r => r.body.model === 'work-fallback') && p.anth.length === 0);
  await p.evaluate(() => { document.getElementById('setup').open = true; }); await p.click('#driveBtn'); await p.waitForTimeout(200);
  check('Test mode: Drive is blocked', /nothing is saved to Drive/.test(await p.textContent('#banner')), await p.textContent('#banner'));
  check('Test mode: no page errors', p.errors.length === 0, p.errors);
  await p.context().close();
  p = await newPage(browser);
  await p.evaluate(() => { document.getElementById('setup').open = true; }); await p.click('#testBtn'); await p.waitForTimeout(800);
  check('Test mode button works on the direct path too (captions appear, banner shown)', parseInt(await p.textContent('#txCount'), 10) >= 1 && !(await p.isHidden('#testBar')));
  await p.context().close();

  // 13. the CSP really blocks a host that is not listed
  p = await newPage(browser, { path: 'direct' });
  const blocked = await p.evaluate(() => fetch('https://example.com/x').then(() => 'allowed', () => 'blocked'));
  const gateOk = await p.evaluate(() => fetch('https://hub.taile4cbbe.ts.net:8444/v1/models', { headers: { authorization: 'Bearer x' } }).then(() => 'allowed', () => 'blocked'));
  check('CSP: a host outside connect-src is blocked at the browser (the gate itself is mocked in this test; its CSP entry is checked in lane_static_test.py)', blocked === 'blocked', [blocked, gateOk]);
  await p.context().close();

  await browser.close(); server.close();
  let failed = 0;
  for (const r of results) { console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : '\n  ' + JSON.stringify(r.detail))); if (!r.ok) failed++; }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL harness error', e); process.exit(1); });
