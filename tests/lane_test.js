// Sidekick work-lane regression test (9 Nov 2026, hub review 2026-11-09-sidekick-door; ported to the lane-only page 23 Nov 2026, hub review 906). Run from the repo root before committing any live.html or routing.json change:
//   node tests/lane_test.js        (needs playwright; nothing leaves the machine: the gate and Drive are mocked in the page, every other request is recorded and aborted)
// The gate is the shared mock tests/gate_mock.js (it wraps fetch for the gate URL inside the page, so SSE chunking, delays and aborts are exact). The page is LANE ONLY since 10 Nov 2026 and has NO fallback
// (Standing Instructions, MEETING SIDEKICK / NO FALLBACK, 9 Nov): when the hub cannot be reached the page stops answering for the call and says so. The checks below pin that. Keys are throwaway test strings.
// Output: check names and PASS/FAIL only (no detail values), so a run never prints caption text or names.
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const { initGate, initScripted } = require('./gate_mock');
const ROOT = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'live.html'), 'utf8');
const patches = [[' if(!OK.test(ev.origin)) return;', ' ']];   // the Teams origin check only; Drive is NOT patched (test mode must block it for real)
for (const [from, to] of patches) {
  const n = html.split(from).length - 1;
  if (n !== 1) { console.log(`FAIL harness: expected 1 match for ${JSON.stringify(from)}, found ${n}`); process.exit(1); }
  html = html.replace(from, to);
}
const dm = html.match(/var DEFAULT_ROUTING=(\{.*?\});\n/);
let BUILTIN = null; try { BUILTIN = JSON.parse(dm[1]); } catch (e) {}
if (!BUILTIN) { console.log('FAIL harness: DEFAULT_ROUTING not found in live.html'); process.exit(1); }
const FILE_ROUTING = JSON.parse(fs.readFileSync(path.join(ROOT, 'routing.json'), 'utf8'));
let routing = fs.readFileSync(path.join(ROOT, 'routing.json'), 'utf8');
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/harness.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); }
  else if (u === '/routing.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(routing); }
  else { res.writeHead(404); res.end(); }
});
const HUBKEY = 'hub' + '-test-' + 'key';
const FLOOR = 98;   // the check count of a clean run, before the floor check itself; raise it by hand when a check is added (a lower count means a scenario stopped early)
const results = [];
const check = (name, ok) => results.push({ name, ok: !!ok });

// ---- in-page helpers (serialised by Playwright: they use nothing outside themselves) ----
// records every Content-Security-Policy violation (a request to a host outside connect-src never reaches the network, so the route guard alone cannot see it)
function initCsp() {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', e => { window.__csp.push(String(e.blockedURI || '')); });
}
// Drive and Google sign-in, mocked in the page: window.google stub plus the Drive upload endpoints of the 11 Nov call store (creates and patches are recorded); a list call answers with no files.
function initDriveUp() {
  const up = window.__up = { creates: [], patches: [], other: 0 };
  window.google = { accounts: { oauth2: { initTokenClient: c => ({ requestAccessToken() { c.callback({ access_token: 'tok', expires_in: 3600 }); } }) } } };
  const prev = window.fetch.bind(window);
  const J = o => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } }));
  window.fetch = function (url, opts) {
    url = String(url); opts = opts || {};
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
      const body = String(opts.body || ''), m = String(opts.method || 'GET').toUpperCase();
      if (m === 'POST') {
        const b = body.split('\r\n')[0], mark = 'Content-Type: text/plain; charset=UTF-8\r\n\r\n', i = body.indexOf(mark);
        let text = i < 0 ? '' : body.slice(i + mark.length); const e = text.lastIndexOf('\r\n' + b + '--'); if (e >= 0) text = text.slice(0, e);
        up.creates.push({ name: (body.match(/"name":"([^"]*)"/) || [])[1] || '', text });
        return J({ id: 'f1' });
      }
      if (m === 'PATCH') { up.patches.push({ text: body }); return J({ id: 'f1' }); }
    }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files')) { up.other++; return J({ files: [] }); }
    return prev(url, opts);
  };
}

// ---- page helper: ONE way to open a page. It always installs the gate mock, the Drive mock (unless o.noDrive), the CSP recorder and the route guard ----
let browser, openCtx = [];
async function open(o) {
  o = o || {};
  const ctx = await browser.newContext();
  openCtx.push(ctx);
  const p = await ctx.newPage();
  p.errors = []; p.blocked = [];
  // the guard: loopback and local schemes pass; every other request is RECORDED (host only) and aborted
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (/^(file:|data:|blob:|about:)/.test(u) || /^http:\/\/127\.0\.0\.1[:/]/.test(u)) return route.continue();
    let h = 'unparsable'; try { h = new URL(u).host; } catch (e) {}
    p.blocked.push(h);
    return route.abort();
  });
  p.on('pageerror', e => p.errors.push(e.message));
  p.on('dialog', d => d.accept());
  await p.addInitScript(initCsp);
  await p.addInitScript(initGate);
  if (!o.noDrive) await p.addInitScript(initDriveUp);
  if (o.script) await p.addInitScript(initScripted, o.script);
  const stored = Object.assign({ hubkey: HUBKEY, gcid: 'y', gfolder: 'z', names: 'Harsh', cap: 200 }, o.settings || {});
  await p.addInitScript(s => { try { if (!localStorage.getItem('sidekick_live')) localStorage.setItem('sidekick_live', JSON.stringify(s)); } catch (e) {} }, stored);
  if (o.plan) await p.addInitScript(pl => { window.__gate.plan = pl.slice(); }, o.plan);
  if (o.dflt) await p.addInitScript(d => { window.__gate.default = d; }, o.dflt);
  await p.goto(o.url || `http://127.0.0.1:${server.address().port}/harness.html`);
  await p.waitForTimeout(150);
  return p;
}
// every scenario runs inside sc(): a throw (element missing, timeout) is recorded as one FAIL and the run goes on; the pages it opened are closed
async function sc(name, fn) {
  try { await fn(); } catch (e) { check('SCENARIO ERROR (' + name + ')', false); }
  for (const c of openCtx) { try { await c.close(); } catch (e) {} }
  openCtx = [];
}
const gateLog = p => p.evaluate(() => window.__gate.log.slice());
const chatCalls = log => log.filter(r => r.method === 'POST' && r.url.endsWith('/v1/chat/completions'));
const modelCalls = log => log.filter(r => r.url.endsWith('/v1/models'));
const taskCalls = (log, task) => chatCalls(log).filter(r => r.body && r.body.metadata && r.body.metadata.hub_task === 'sidekick-' + task);
const feed = (p, caps) => p.evaluate(c => window.postMessage({ sk: 'cap1', caps: c }, '*'), caps);
async function wrap(p, wait) {
  wrap.n = (wrap.n || 0) + 1;
  await feed(p, [{ id: 'a' + wrap.n, author: 'Pat Example', text: 'Synthetic caption number ' + wrap.n + ' about the demo item.' }]);
  await p.waitForTimeout(250);
  await p.click('#wrapBtn');
  await p.waitForTimeout(wait || 900);
  return p.evaluate(() => document.getElementById('wrapOut').textContent);
}
// nothing was sent or attempted to any host other than the mocked gate: the route guard recorded no request and the CSP recorder saw no http(s) violation (loopback excepted)
async function clean(p) {
  const csp = await p.evaluate(() => (window.__csp || []).slice());
  return p.blocked.length === 0 && !csp.some(u => /^(https?|wss?):/.test(u) && !/^http:\/\/127\.0\.0\.1[:/]/.test(u));
}
const text = (p, sel) => p.textContent(sel);
const hidden = (p, sel) => p.isHidden(sel);

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch();
  let p, out, log, c;

  // 0. control page for the egress guard: a known forbidden request MUST be recorded, or "nothing was sent elsewhere" proves nothing
  await sc('0 guard control', async () => {
    p = await open({ noDrive: true });
    await p.evaluate(() => { fetch('https://example.com/ctl').catch(() => {}); fetch('https://www.googleapis.com/drive/v3/files/ctl').catch(() => {}); });
    await p.waitForTimeout(400);
    const csp = await p.evaluate(() => window.__csp.slice());
    check('Guard control: a request the CSP allows but the suite does not mock (Drive) is recorded and aborted by the route guard', p.blocked.indexOf('www.googleapis.com') >= 0);
    check('Guard control: a request to a host the CSP does not allow is recorded by the violation recorder', csp.some(u => /example\.com/.test(u)));
    check('Guard control: clean() reports the control page as NOT clean', !(await clean(p)));
  });

  // 1. the page is lane only: old direct-path settings in a browser are purged on load, and the wrap goes to the gate
  await sc('1 purge of the old direct settings', async () => {
    p = await open({ settings: { apikey: 'x', orkey: 'k', path: 'direct', mFast: 'f', mSmart: 's' } });
    out = await wrap(p);
    log = await gateLog(p);
    const stored = await p.evaluate(() => JSON.parse(localStorage.getItem('sidekick_live') || '{}'));
    check('Purge: apikey, orkey, path, mFast and mSmart are gone from the saved settings (the hub key is kept)', ['apikey', 'orkey', 'path', 'mFast', 'mSmart'].every(k => !(k in stored)) && stored.hubkey === HUBKEY);
    check('Purge: there is no Anthropic key field and no direct-path toggle on the page', await p.evaluate(() => !document.getElementById('apikey') && !document.getElementById('pathDirect') && !document.getElementById('pathLane')));
    check('Purge page: the wrap went to the gate as work-sonnet and nothing was sent or attempted elsewhere', out === 'LANE:work-sonnet' && chatCalls(log).length >= 1 && chatCalls(log)[0].body.model === 'work-sonnet' && await clean(p));
    check('Purge page: no page errors', p.errors.length === 0);
  });

  // 2. lane wrap: OpenAI format, streaming, group from routing.json, hub key only
  await sc('2 lane wrap', async () => {
    p = await open();
    await p.waitForTimeout(200);
    out = await wrap(p);
    log = await gateLog(p); c = chatCalls(log)[0];
    check('Lane: probe GET /v1/models ran at page start with the hub key', modelCalls(log).length >= 1 && modelCalls(log)[0].auth === 'Bearer ' + HUBKEY);
    check('Lane: wrap went to the gate chat-completions as work-sonnet, streaming', !!c && c.method === 'POST' && c.body.model === 'work-sonnet' && c.body.stream === true);
    check('Lane: OpenAI shape (system MESSAGE first, user second, no top-level system field)', !!c && c.body.messages[0].role === 'system' && c.body.messages[1].role === 'user' && !('system' in c.body));
    check('Lane: Authorization is the hub key; no Anthropic key header is sent', !!c && c.auth === 'Bearer ' + HUBKEY && !c.hasAnthropicKey);
    check('Lane: x-sk-fallbacks is always 0 (there is no fallback)', !!c && c.fallbacks === '0');
    check('Lane: max_tokens is the wrap value of the served routing.json', !!c && c.body.max_tokens === FILE_ROUTING.tasks.wrap.max_tokens);
    check('Lane: the streamed text is shown and nothing was sent or attempted to any host other than the mocked gate', out === 'LANE:work-sonnet' && await clean(p));
    check('Lane: header shows the answering model and the last reply model', /Answering: work-sonnet \(detect: work-fallback\)/.test(await text(p, '#modelPill')) && /last: anthropic\/claude-sonnet-5\.5/.test(await text(p, '#modelPill')));
    check('Lane: pill says ok with a first-byte time', /Work lane: ok \(work-sonnet, first byte \d+ ms\)/.test(await text(p, '#lanePill')));
    check('Lane: usage pill counts the call', /1 calls today/.test(await text(p, '#aiPill')));
    check('Lane: no page errors', p.errors.length === 0);
  });

  // 3. aimed-at-me detection uses work-fallback, then the answer uses work-sonnet
  await sc('3 detection and answer', async () => {
    p = await open({ dflt: 'detect-no' });
    await feed(p, [{ id: 'd1', author: 'Pat Example', text: 'Harsh, can you confirm the synthetic demo item is ready?' }]);
    await p.waitForTimeout(4200);
    log = await gateLog(p);
    check('Detection (aimed at me) went to work-fallback', taskCalls(log, 'detect').length >= 1 && taskCalls(log, 'detect')[0].body.model === 'work-fallback');
    check('Detection max_tokens comes from routing.json and nothing was sent or attempted elsewhere', taskCalls(log, 'detect').length >= 1 && taskCalls(log, 'detect')[0].body.max_tokens === FILE_ROUTING.tasks.detect.max_tokens && await clean(p));
  });
  await sc('3 answer', async () => {
    p = await open();   // default mode ok: the detection reply is not JSON, so the page shows the check; the answer path is exercised by the say box
    await p.fill('#sayIn', 'update on the demo item'); await p.click('#sayBtn'); await p.waitForTimeout(900);
    log = await gateLog(p);
    check('Answer ("What should I say?") went to work-sonnet', chatCalls(log).some(r => r.body.model === 'work-sonnet'));
  });

  // 4. streaming: a line split across chunks is reassembled; a plain completion body is accepted
  await sc('4 stream split', async () => {
    p = await open({ dflt: 'split' });
    out = await wrap(p);
    check('Stream: SSE lines split across chunks are reassembled', out === 'Hello wrap world');
  });
  await sc('4 stream plain', async () => {
    p = await open({ dflt: 'plain' });
    out = await wrap(p);
    check('Stream: a plain (non-stream) completion body is accepted too', out === 'PLAIN COMPLETION');
  });

  // 5. refusals: shown, never retried, never a stop, never sent anywhere else
  for (const [mode, want, label] of [['refused-client', 'blocked by the work-lane rule', 'client-term refusal (400)'], ['refused-kill', 'switched off', 'kill switch (429)'], ['refused-cap', 'switched off', 'cap reached (429)'],
                                      ['http503refused', 'blocked by the work-lane rule', 'refused 503 (spend unreadable)'], ['refused-500', 'blocked by the work-lane rule', 'refused 500'], ['refused-in-stream', 'blocked by the work-lane rule', 'refusal inside the stream']]) {
    await sc('5 refusal ' + label, async () => {
      p = await open({ dflt: mode });
      out = await wrap(p, 2600);   // long enough to include the first retry wait (2 s) if the page ever retried a refusal
      log = await gateLog(p);
      check(`Refusal ${label}: shown as "${want}"`, out.indexOf(want) >= 0);
      check(`Refusal ${label}: exactly 1 gate chat call, no retry, no banner, nothing sent or attempted elsewhere`, chatCalls(log).length === 1 && await hidden(p, '#laneBar') && await clean(p));
      check(`Refusal ${label}: lane pill is bad and the lane is not stopped`, /bad/.test(await p.getAttribute('#lanePill', 'class')) && !/stopped/.test(await text(p, '#modelPill')));
    });
  }
  await sc('5 repeated refusals', async () => {
    p = await open({ dflt: 'refused-kill' });
    for (let i = 0; i < 4; i++) { await feed(p, [{ id: 'r' + i, author: 'Pat Example', text: 'Another synthetic line ' + i }]); await p.waitForTimeout(100); await p.click('#wrapBtn'); await p.waitForTimeout(500); }
    check('Repeated refusals never trigger the 3-failure pause (the real reason stays visible)', chatCalls(await gateLog(p)).length === 4 && !/PAUSED/.test(await text(p, '#aiPill')) && /switched off/.test(await text(p, '#wrapOut')));
  });

  // 6. the hub cannot be reached (NO FALLBACK, 9 Nov): two transport failures in a row, then the health probe also fails -> the lane STOPS for this call, visibly; nothing goes anywhere else; New call or Retry hub recovers
  for (const [mode, probeMode] of [['network', 'network'], ['http502', 'models502'], ['http504', 'models502'], ['http503plain', 'models502']]) {
    await sc('6 transport ' + mode, async () => {
      p = await open({ dflt: mode });   // the page-start probe is a GET and succeeds; only chat calls fail
      await p.evaluate(pm => { window.__gate.log.length = 0; window.__gate.plan = [pm.m, pm.m, pm.pr]; }, { m: mode, pr: probeMode });
      out = await wrap(p, 3800);
      log = await gateLog(p);
      check(`Transport ${mode}: the wrap says "stopped for this call" after 1 to 2 gate chat calls`, /stopped for this call/.test(out) && chatCalls(log).length >= 1 && chatCalls(log).length <= 2);
      check(`Transport ${mode}: the banner says the lane is stopped and Retry hub is shown`, !(await hidden(p, '#laneBar')) && /stopped for this call/.test(await text(p, '#laneBar')) && !(await hidden(p, '#retryHub')));
      const before = chatCalls(await gateLog(p)).length;
      await p.click('#wrapBtn'); await p.waitForTimeout(700);
      check(`Transport ${mode}: the rest of the call stays stopped (a second tap sends no gate call)`, before >= 1 && chatCalls(await gateLog(p)).length === before && /stopped for this call/.test(await text(p, '#wrapOut')));
      check(`Transport ${mode}: header shows the lane as stopped`, /stopped for this call/.test(await text(p, '#modelPill')));
      // New call: the hub is tried again
      await p.evaluate(() => { window.__gate.default = 'ok'; window.__gate.plan = []; window.__gate.log.length = 0; });
      await p.click('#newCall'); await p.click('#clearAnyway'); await p.waitForTimeout(400);
      check(`Transport ${mode}: New call hides the banner and probes the hub again (1 GET /v1/models)`, (await hidden(p, '#laneBar')) && modelCalls(await gateLog(p)).length === 1);
      out = await wrap(p, 900);
      check(`Transport ${mode}: after New call the lane answers again`, out === 'LANE:work-sonnet');
      check(`Transport ${mode}: nothing was sent or attempted to any host other than the mocked gate`, await clean(p));
      check(`Transport ${mode}: no page errors`, p.errors.length === 0);
    });
  }

  // 7. first-byte deadline (routing.json: a 1000 ms deadline for wrap): no first byte is NOT a stop: one retry with double the wait, then the error is shown for this request only
  routing = JSON.stringify(Object.assign(JSON.parse(routing), { tasks: Object.assign(JSON.parse(routing).tasks, { wrap: { group: 'work-sonnet', first_byte_ms: 1000, max_tokens: 3333 } }) }));
  for (const mode of ['slowfirst', 'slowbody']) {
    await sc('7 deadline ' + mode, async () => {
      p = await open({ dflt: mode });
      out = await wrap(p, 4500);
      log = await gateLog(p);
      check(`Deadline (${mode}): exactly 2 gate chat calls (one retry at double the wait) and the error is shown for this request`, chatCalls(log).length === 2 && /no first byte within 2000 ms/.test(out));
      check(`Deadline (${mode}): the lane is not stopped and nothing was sent or attempted elsewhere`, chatCalls(log).length === 2 && (await hidden(p, '#laneBar')) && !/stopped/.test(await text(p, '#modelPill')) && await clean(p));
      check(`Deadline (${mode}): routing.json's max_tokens (3333) was in the request`, chatCalls(log).length >= 1 && chatCalls(log)[0].body.max_tokens === 3333);
    });
  }
  routing = fs.readFileSync(path.join(ROOT, 'routing.json'), 'utf8');

  // 8. after the first byte a break is NOT a stop: the same path is retried
  await sc('8 mid-stream break', async () => {
    p = await open();
    await p.evaluate(() => { window.__gate.log.length = 0; window.__gate.plan = ['break-mid', 'ok']; });
    out = await wrap(p, 4200);
    log = await gateLog(p);
    check('Mid-stream break: retried on the lane (2 gate chat calls), no stop, nothing sent or attempted elsewhere', out === 'LANE:work-sonnet' && chatCalls(log).length === 2 && (await hidden(p, '#laneBar')) && await clean(p));
  });

  // 9. rate limit and key errors are not transport failures
  await sc('9 rate limit', async () => {
    p = await open();
    await p.evaluate(() => { window.__gate.log.length = 0; window.__gate.plan = ['rate429', 'ok']; });
    out = await wrap(p, 3800);
    check('Gate rate limit (429, not refused): retried on the lane (2 gate chat calls), no stop, nothing sent or attempted elsewhere', out === 'LANE:work-sonnet' && chatCalls(await gateLog(p)).length === 2 && (await hidden(p, '#laneBar')) && await clean(p));
  });
  for (const [mode, want] of [['http401', 'hub key was rejected'], ['http403origin', 'not allowed']]) {
    await sc('9 ' + mode, async () => {
      p = await open({ dflt: mode });
      out = await wrap(p, 1200);
      check(`Gate ${mode}: shown ("${want}") after exactly 1 gate chat call, no stop, nothing sent or attempted elsewhere`, out.indexOf(want) >= 0 && chatCalls(await gateLog(p)).length === 1 && (await hidden(p, '#laneBar')) && await clean(p));
    });
  }

  // 10. the health probe and the hub key
  await sc('10 probe at page start', async () => {
    p = await open();
    await p.waitForTimeout(300);
    log = await gateLog(p);
    check('Page start probes GET /v1/models with the hub key and the pill says "reachable (2 models)" (before any call)', modelCalls(log).length === 1 && modelCalls(log)[0].auth === 'Bearer ' + HUBKEY && chatCalls(log).length === 0 && /reachable \(2 models\)/.test(await text(p, '#lanePill')));
  });
  await sc('10 probe failure at page start', async () => {
    p = await open({ plan: ['network'] });
    await p.waitForTimeout(300);
    check('Probe failure at page start (transport): the lane is stopped, the banner says so and names the health check', !(await hidden(p, '#laneBar')) && /stopped for this call/.test(await text(p, '#laneBar')) && /health check/.test(await text(p, '#laneBar')));
    out = await wrap(p, 1000);
    log = await gateLog(p);
    check('Probe failure: the first call sends no gate chat call, says "stopped for this call" and nothing was sent or attempted elsewhere', chatCalls(log).length === 0 && /stopped for this call/.test(out) && modelCalls(log).length === 1 && await clean(p));
    await p.click('#retryHub'); await p.waitForTimeout(300);
    out = await wrap(p, 900);
    log = await gateLog(p);
    check('Probe failure: Retry hub probes again and the next wrap is answered on the lane', modelCalls(log).length === 2 && out === 'LANE:work-sonnet' && (await hidden(p, '#laneBar')));
  });
  await sc('10 probe 401', async () => {
    p = await open({ plan: ['models401'] });
    await p.waitForTimeout(300);
    check('Probe 401: shown as a key problem, not a stop', /rejected/.test(await text(p, '#lanePill')) && (await hidden(p, '#laneBar')));
  });
  await sc('10 no hub key', async () => {
    p = await open({ settings: { hubkey: '' } });
    out = await wrap(p, 500);
    check('No hub key: a clear error, no network call to the gate, nothing sent or attempted elsewhere', /hub key/.test(out) && (await gateLog(p)).length === 0 && await clean(p));
  });

  // 11. routing.json: invalid content (the auto router, bad numbers) is rejected for the built-in copy; the built-in values are read from live.html (DEFAULT_ROUTING), not from routing.json
  routing = JSON.stringify(Object.assign(JSON.parse(routing), { tasks: Object.assign(JSON.parse(routing).tasks, { wrap: { group: 'work-auto', first_byte_ms: 1000, max_tokens: 3333 } }) }));
  await sc('11 routing rejected', async () => {
    p = await open();
    await wrap(p, 900);
    c = chatCalls(await gateLog(p))[0];
    check('routing.json naming work-auto is rejected: the built-in routes of live.html are used (its work-sonnet and its wrap max_tokens)', !!c && c.body.model === BUILTIN.tasks.wrap.group && c.body.model === 'work-sonnet' && c.body.max_tokens === BUILTIN.tasks.wrap.max_tokens && c.body.max_tokens !== 3333);
  });
  routing = fs.readFileSync(path.join(ROOT, 'routing.json'), 'utf8');

  // 12. test mode: synthetic captions through the gate, Drive blocked, banner shown
  await sc('12 test mode', async () => {
    p = await open({ dflt: 'detect-no', url: `http://127.0.0.1:${server.address().port}/harness.html?test=1` });
    await p.waitForTimeout(8200);
    check('Test mode: banner shown and synthetic captions arrive', !(await hidden(p, '#testBar')) && /TEST MODE/.test(await text(p, '#testBar')) && parseInt(await text(p, '#txCount'), 10) >= 2);
    check('Test mode: the synthetic "Harsh, can you confirm" caption reached the lane (work-fallback) and nothing was sent or attempted elsewhere', taskCalls(await gateLog(p), 'detect').some(r => r.body.model === 'work-fallback') && await clean(p));
    await p.evaluate(() => { document.getElementById('setup').open = true; }); await p.click('#driveBtn'); await p.waitForTimeout(200);
    check('Test mode: Drive is blocked', /nothing is saved to Drive/.test(await text(p, '#banner')));
    check('Test mode: no page errors', p.errors.length === 0);
  });
  await sc('12 test mode button', async () => {
    p = await open();
    await p.evaluate(() => { document.getElementById('setup').open = true; }); await p.click('#testBtn'); await p.waitForTimeout(800);
    check('Test mode button works (captions appear, banner shown)', parseInt(await text(p, '#txCount'), 10) >= 1 && !(await hidden(p, '#testBar')));
  });

  // 13. the CSP really blocks a host that is not listed (this page is the one that is EXPECTED to violate it, so the guard check is not applied)
  await sc('13 csp', async () => {
    p = await open();
    const blocked = await p.evaluate(() => fetch('https://example.com/x').then(() => 'allowed', () => 'blocked'));
    const gateOk = await p.evaluate(() => fetch('https://hub.taile4cbbe.ts.net:8444/v1/models', { headers: { authorization: 'Bearer x' } }).then(() => 'allowed', () => 'blocked'));
    check('CSP: a host outside connect-src is blocked at the browser (the gate itself is mocked in this test; its CSP entry is checked in lane_static_test.py)', blocked === 'blocked' && gateOk === 'allowed');
    check('CSP: the violation recorder saw the blocked host and the route guard saw nothing', (await p.evaluate(() => window.__csp.slice())).some(u => /example\.com/.test(u)) && p.blocked.length === 0);
  });

  await browser.close(); server.close();
  check("suite ran at least " + FLOOR + " checks (a lower count means a scenario stopped early)", results.length >= FLOOR);
  // a scenario that died leaves checks unreached: each one is printed as a FAIL row (name from tests/lane_names.json), so the floor and the name match still work
  const have = new Set(results.map(r => r.name));
  for (const n of JSON.parse(fs.readFileSync(path.join(__dirname, 'lane_names.json'), 'utf8'))) if (!have.has(n)) check('NOT RUN: ' + n, false);
  let failed = 0;
  for (const r of results) { console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name); if (!r.ok) failed++; }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL harness error'); process.exit(1); });
