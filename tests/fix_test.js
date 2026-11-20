// Sidekick regression test for the call-card pick and the live answers (20 Nov 2026, fixes a-d from Harsh's request; hub review 2026-11-20-sidekick-card-answers).
//   node tests/fix_test.js        (needs playwright; the gate, Drive and Google sign-in are mocked inside the page, nothing leaves the machine)
// Style of tests/lane_test.js: the gate mock is shared (tests/gate_mock.js). The clock is faked INSIDE the page (initClock, no Playwright version needed): Date is fixed at a BC time
// that the test moves; timers keep running in real time (the 1 s Worker tick and the mock's delays). Because Date.now() stands still between steps, "a line settles after 2.5 s"
// never fires on its own: a test moves the clock when it wants a caption checked.
// Dates: Mon 23 Nov 2026, BC time (UTC-7 all year). All captions, names and titles are invented; there is no client text.
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const { initGate, initScripted } = require('./gate_mock');   // a copy of lane_test.js's mock, used only here
const ROOT = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'live.html'), 'utf8');
const patches = [[' if(!OK.test(ev.origin)) return;', ' ']];   // the Teams origin check only (same as lane_test.js)
for (const [from, to] of patches) {
  const n = html.split(from).length - 1;
  if (n !== 1) { console.log(`FAIL harness: expected 1 match for ${JSON.stringify(from)}, found ${n}`); process.exit(1); }
  html = html.replace(from, to);
}
const routing = fs.readFileSync(path.join(ROOT, 'routing.json'), 'utf8');
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/harness.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); }
  else if (u === '/routing.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(routing); }
  else { res.writeHead(404); res.end(); }
});
const HUBKEY = 'hub' + '-test-' + 'key';
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

// ---- in-page helpers (serialised by Playwright: they use nothing outside themselves) ----
function initClock(a) {
  const RealDate = Date; let fixed = a.t;
  window.__setNow = t => { fixed = t; };
  function FakeDate(...args) { if (!new.target) return new RealDate(fixed).toString(); return args.length ? new RealDate(...args) : new RealDate(fixed); }
  FakeDate.prototype = RealDate.prototype; FakeDate.now = () => fixed; FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC;
  window.Date = FakeDate;
  try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: t => { window.__clip = t; return Promise.resolve(); } }, configurable: true }); } catch (e) {}
}
// Drive and Google sign-in, mocked: the list call, the pack file and the call-sheet file. A test changes window.__drive and moves the clock past routing pack.poll_ms (120 s).
function initDrive(cfg) {
  window.__drive = { pack: cfg.pack, calls: cfg.calls, callsTok: 'c1' };
  window.google = { accounts: { oauth2: { initTokenClient: c => ({ requestAccessToken() { c.callback({ access_token: 'tok', expires_in: 3600 }); } }) } } };
  const prev = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    url = String(url);
    if (!url.startsWith('https://www.googleapis.com/drive/v3/files')) return prev(url, opts);
    const d = window.__drive, J = o => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } }));
    if (url.indexOf('?q=') > -1) return J({ files: [{ id: 'pk', name: 'sidekick-pack.json', modifiedTime: '2026-11-23T15:00:00Z', md5Checksum: 'pm1' }, { id: 'ck', name: 'sidekick-calls.json', modifiedTime: '2026-11-23T15:00:00Z', md5Checksum: d.callsTok }] });
    if (url.indexOf('/pk?alt=media') > -1) return J(d.pack);
    if (url.indexOf('/ck?alt=media') > -1) return new Promise(r => setTimeout(r, d.callsDelay || 0)).then(() => J({ calls: d.calls, built: '2026-11-23 15:00' }));
    return Promise.resolve(new Response('{}', { status: 404 }));
  };
}

// ---- data ----
// BC is UTC-7 all year from Nov 2026, but the browser's own tz data may still say UTC-8 for America/Vancouver (the page formats with Intl and that zone, on purpose). So the offset is read from the
// browser under test (see main), and BC() builds instants that the page will format as the same wall-clock time the check labels name.
let OFFH = 7;
const BC = (h, m, s) => Date.UTC(2026, 10, 23, h + OFFH, m, s || 0);
const iso = t => new Date(t).toISOString();
const card = (id, title, s, e, extra) => Object.assign({ id, title, start: s == null ? undefined : iso(s), end: e == null ? undefined : iso(e), time: '', say: ['say ' + id], note: 'NOTE-' + id + ' CARDMARK-' + id }, extra || {});
let ST, A, B, C, T;
function initData() {
  ST = card('st', 'Status card', BC(0, 0), BC(0, 0));
  A = card('a', 'Call Alpha', BC(8, 30), BC(9, 0), { ask: ['ledger approval backlog needed'] });
  B = card('b', 'Call Bravo', BC(9, 0), BC(9, 30), { ask: ['invoice reconciliation widget pending'] });
  C = card('c', 'Call Charlie', BC(9, 10), BC(9, 40));
  T = card('t', 'No times', null, null);
}
const pack = calls => ({ built: '2026-11-23 15:00', items: [], people: [], me: { teams_name: 'Sharma, Harsh' }, calls });
const nobody = { pack: pack([]) };   // placeholder so a Drive pack file carries no calls (the call sheets come from their own file, like the real hub)

const sleep = ms => new Promise(r => setTimeout(r, ms));
const setNow = (p, t) => p.evaluate(t => window.__setNow(t), t);
const which = async p => { const t = await p.textContent('#callBody'); const m = t.match(/NOTE-([A-Za-z0-9]+)/); return m ? m[1] : (/No scheduled call now/.test(t) ? 'none' : t.slice(0, 40)); };
const autoLabel = p => p.evaluate(() => document.getElementById('callSel').selectedOptions[0].textContent);
const gateLog = p => p.evaluate(() => window.__gate.log.slice());
const posts = (log, task) => log.filter(r => r.method === 'POST' && r.body && r.body.metadata && r.body.metadata.hub_task === 'sidekick-' + task);
const sysOf = r => r.body.messages[0].content, userOf = r => r.body.messages[1].content;
const feed = (p, caps) => p.evaluate(c => window.postMessage({ sk: 'cap1', caps: c }, '*'), caps);
async function feedAt(p, t, id, author, text) { await setNow(p, t); await feed(p, [{ id, author, text }]); await p.waitForTimeout(60); }
const askSay = p => p.textContent('#askSay');
const waitSay = (p, s, ms) => p.waitForFunction(x => document.getElementById('askSay').textContent === x, s, { timeout: ms || 9000 }).then(() => true, () => false);

async function newPage(browser, o) {
  o = o || {};
  const ctx = await browser.newContext({ timezoneId: 'America/Vancouver' });
  const p = await ctx.newPage(); p.setDefaultTimeout(5000);
  p.errors = []; p.on('pageerror', e => p.errors.push(e.message));
  p.on('dialog', d => d.accept());
  await p.addInitScript(initClock, { t: o.now });
  await p.addInitScript(initGate);
  if (o.script) await p.addInitScript(initScripted, o.script);
  if (o.drive) await p.addInitScript(initDrive, o.drive);
  const settings = Object.assign({ hubkey: HUBKEY, names: 'Harsh', cap: 200 }, o.drive ? { gcid: 'y', gfolder: 'z' } : {});
  await p.addInitScript(a => { try { if (!localStorage.getItem('sidekick_live')) localStorage.setItem('sidekick_live', JSON.stringify(a.s)); if (a.pack && !localStorage.getItem('sidekick_live_pack')) localStorage.setItem('sidekick_live_pack', JSON.stringify(a.pack)); } catch (e) {} }, { s: settings, pack: o.pack });
  await p.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
  await p.waitForTimeout(300);
  return p;
}
const cand = (...c) => JSON.stringify({ candidates: c });
const ans = (say) => JSON.stringify({ say, capture: '', source: 's', if_pushed: 'p' });

// the invented room-question call used by the answer and detect tests (times are BC, line numbers are the snapshot numbers the page sends). The wording is deliberately neutral
// (no name of Harsh, no request words, no question mark) so the page's own caption triggers stay quiet when the test moves the clock; the model is mocked, so the detect reply decides what counts as the question.
async function feedCall(p) {
  await feedAt(p, BC(9, 5, 10), 'k1', 'Pat Sample', 'The sample item status came up earlier in the call.');
  await feedAt(p, BC(9, 8, 0), 'k2', 'Pat Sample', 'Thanks for that.');
  await feedAt(p, BC(9, 10, 20), 'k3', 'Doug Example', 'Our parts order report shows one of three orders per work order and the cause is unclear');
  await feedAt(p, BC(9, 11, 0), 'k4', 'Pat Sample', 'Interesting, I will look into it.');
  await setNow(p, BC(9, 11, 30));
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch();
  let p, log;
  {   // wall-clock offset of America/Vancouver in THIS browser on the test date
    const pg = await browser.newPage();
    const h = await pg.evaluate(t => parseInt(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)), 10), Date.UTC(2026, 10, 23, 12));
    await pg.close(); OFFH = 12 - h; initData();
    console.log('note: this browser formats America/Vancouver on 23 Nov 2026 as UTC-' + OFFH);
  }
  // a scenario that throws (element missing, timeout) is recorded as one FAIL and the run goes on, so a negative run shows per-check failures
  async function sc(name, fn) {
    try { await fn(); } catch (e) { check('SCENARIO ERROR (' + name + '): ' + String(e.message || e).split('\n')[0], false, String(e.stack || e).slice(0, 400)); }
    try { if (p) await p.context().close(); } catch (e2) {}
  }

  // ===== (a) + (b): which card =====
  await sc('a-b card flow', async () => {
    p = await newPage(browser, { now: BC(8, 40), pack: pack([ST, A, B]) });
    check('a: page load at 08:40 shows Alpha, as Auto', await which(p) === 'a' && /^Auto: Call Alpha/.test(await autoLabel(p)), [await which(p), await autoLabel(p)]);
    await setNow(p, BC(8, 44)); await p.waitForTimeout(1400);
    check('b: 08:44, still Alpha', await which(p) === 'a');
    await setNow(p, BC(8, 58)); await p.waitForTimeout(1400);
    check('b: periodic check at 08:58 keeps the running call (the next call has not started)', await which(p) === 'a', await which(p));
    await p.click('#newCall'); await p.waitForTimeout(300);
    check('a: New call at 08:58 re-picks an auto card: Bravo, the next call (starts within 15 min)', await which(p) === 'b' && /^Auto: Call Bravo/.test(await autoLabel(p)), [await which(p), await autoLabel(p)]);
    check('a: the auto switch raises no banner', await p.isHidden('#banner'));
    await setNow(p, BC(9, 0)); await p.waitForTimeout(1400);
    check('b: at 09:00:00 Bravo (its start has passed, Alpha has ended)', await which(p) === 'b');
    await setNow(p, BC(9, 1)); await p.waitForTimeout(1400);
    check('b: at 09:01 Bravo', await which(p) === 'b');
    await feedAt(p, BC(9, 1, 5), 'h1', 'Pat Sample', 'Short caption for the call health line.');
    await p.click('#wrapBtn'); await p.waitForTimeout(900); await p.click('#copyWrap'); await p.waitForTimeout(200);
    const clip = await p.evaluate(() => window.__clip || '');
    check('call health lists the card with how it was chosen and when', /call card: Call Bravo \(auto\) from 08:58/.test(clip), clip.split('\n').filter(l => /call card/.test(l)));
    check('a-b: no page errors', p.errors.length === 0, p.errors);
    await p.context().close();
  });

  // load-time picks (explicit rule, half-open windows, status card, timeless card)
  for (const [t, want, label, calls] of [
    [BC(8, 44), 'a', 'load 08:44: Alpha (Bravo is 16 min away)', [ST, A, B]],
    [BC(8, 45), 'b', 'load 08:45: Bravo (exactly 15 min away)', [ST, A, B]],
    [BC(8, 58), 'b', 'load 08:58: Bravo, not the running Alpha', [ST, A, B]],
    [BC(9, 0, 0), 'b', 'load 09:00:00: Bravo only (Alpha ended; windows are half-open)', [ST, A, B]],
    [BC(9, 1), 'b', 'load 09:01: Bravo', [ST, A, B]],
    [BC(9, 30, 0), 'st', 'load 09:30:00: nothing running, the status card (never a call that ended)', [ST, A, B]],
    [BC(8, 58), 'b', 'three calls, load 08:58: Bravo, the SOONEST next start, not Charlie (09:10)', [ST, A, B, C]],
    [BC(9, 12), 'c', 'three calls, load 09:12: both Bravo and Charlie run, the latest start wins', [ST, A, B, C]],
    [BC(8, 58), 'b', 'a card with no times is never picked', [T, A, B]],
    [BC(11, 0), 'none', 'no status card, gap at 11:00: "No scheduled call now", not the first call of the day', [T, A, B]],
    [BC(11, 0), 'st', 'status card day, gap at 11:00: the status card, never the zero-length card inside a window', [ST, T, A, B]],
  ]) {
    await sc('load-time pick: ' + label, async () => {
      p = await newPage(browser, { now: t, pack: pack(calls) });
      check('b: ' + label, await which(p) === want && p.errors.length === 0, [await which(p), p.errors]);
      await p.context().close();
    });
  }

  // a call that runs over its end keeps its card (no drop to nothing)
  await sc('overrun', async () => {
    p = await newPage(browser, { now: BC(8, 40), pack: pack([ST, A]) });
    await setNow(p, BC(9, 35)); await p.waitForTimeout(1400);
    check('b: Alpha overruns to 09:35 with no next call: still Alpha', await which(p) === 'a', await which(p));
    await p.context().close();
  });

  // no-match state: renders without error, no card text goes to any model request
  await sc('no-match', async () => {
    p = await newPage(browser, { now: BC(11, 0), pack: pack([T, A, B]) });
    await feedAt(p, BC(11, 0, 5), 'n1', 'Pat Sample', 'A short caption for the brief.');
    await p.click('#briefBtn'); await p.waitForTimeout(700);
    log = await gateLog(p);
    check('no-match: the page renders "No scheduled call now" and sends no call sheet or card text', /No scheduled call now/.test(await p.textContent('#callBody')) && posts(log, 'brief').length === 1 && !/CURRENT CALL SHEET|CARDMARK/.test(sysOf(posts(log, 'brief')[0])), [await p.textContent('#callBody'), p.errors]);
    check('no-match: no page errors', p.errors.length === 0, p.errors);
    await p.context().close();
  });

  // ===== (a): a hand pick holds, New call and Auto end it =====
  await sc('manual', async () => {
    p = await newPage(browser, { now: BC(9, 1), pack: pack([ST, A, B]) });
    check('manual: starts on auto (Bravo)', await which(p) === 'b');
    await p.selectOption('#callSel', 'a'); await p.waitForTimeout(150);
    check('manual: picking Alpha by hand shows Alpha', await which(p) === 'a' && !/^Auto/.test(await autoLabel(p)), [await which(p), await autoLabel(p)]);
    await setNow(p, BC(9, 20)); await p.waitForTimeout(2300);
    check('manual: a hand pick stays put across ticks', await which(p) === 'a', await which(p));
    await p.click('#newCall'); await p.waitForTimeout(300);
    check('manual: New call ends the hand pick and re-picks (Bravo is running at 09:20)', await which(p) === 'b' && /^Auto: Call Bravo/.test(await autoLabel(p)), [await which(p), await autoLabel(p)]);
    await p.selectOption('#callSel', 'a'); await p.waitForTimeout(150);
    await p.selectOption('#callSel', '__auto'); await p.waitForTimeout(150);
    check('manual: the Auto entry returns to the auto card without New call', await which(p) === 'b' && /^Auto: Call Bravo/.test(await autoLabel(p)), [await which(p), await autoLabel(p)]);
    check('manual: no page errors', p.errors.length === 0, p.errors);
    await p.context().close();
  });

  // after "Auto" the select keeps focus in the browser: the page lets go of it, so the card still switches at the next call's start
  await sc('auto after focus', async () => {
    p = await newPage(browser, { now: BC(8, 40), pack: pack([ST, A, B]) });
    await p.focus('#callSel'); await p.selectOption('#callSel', 'b'); await p.waitForTimeout(150);
    check('auto-focus: a hand pick of Bravo at 08:40', await which(p) === 'b' && !/^Auto/.test(await autoLabel(p)));
    await p.focus('#callSel'); await p.selectOption('#callSel', '__auto'); await p.waitForTimeout(150);
    check('auto-focus: Auto returns to Alpha', await which(p) === 'a' && /^Auto: Call Alpha/.test(await autoLabel(p)), [await which(p), await autoLabel(p)]);
    await setNow(p, BC(9, 1)); await p.waitForTimeout(1600);
    check('auto-focus: after Auto the card switches to Bravo at its start (focus is not left on the list)', await which(p) === 'b', await which(p));
  });

  // the open list is never rebuilt under his hand
  await sc('focus', async () => {
    p = await newPage(browser, { now: BC(8, 40), pack: pack([ST, A, B]) });
    await p.focus('#callSel'); await setNow(p, BC(9, 1)); await p.waitForTimeout(1500);
    check('focus: while the card list has focus the card does not switch', await which(p) === 'a', await which(p));
    await p.evaluate(() => document.getElementById('callSel').blur()); await p.waitForTimeout(1500);
    check('focus: once it loses focus the card switches to Bravo', await which(p) === 'b', await which(p));
    await p.context().close();
  });

  // the nudge reads the right card (a stale card also gave wrong "Good moment to raise" lines)
  await sc('nudge', async () => {
    p = await newPage(browser, { now: BC(9, 1), pack: pack([ST, A, B]) });
    await feedAt(p, BC(9, 1, 0), 'u1', 'Pat Sample', 'the invoice reconciliation widget is still pending for now');
    await setNow(p, BC(9, 1, 4)); await p.waitForTimeout(1500);
    check('nudge: "Good moment to raise" comes from Bravo\'s card', /Good moment to raise: invoice reconciliation widget pending/.test(await p.textContent('#callNudge')), await p.textContent('#callNudge'));
    await p.context().close();
  });

  // ===== (a) cached pack at load, then Drive data (applyCalls) =====
  await sc('drive refresh', async () => {
    const yesterday = [card('st0', 'Status card yesterday', BC(0, 0) - 86400000, BC(0, 0) - 86400000), card('y1', 'Call Yesterday', BC(8, 30) - 86400000, BC(9, 0) - 86400000)];
    p = await newPage(browser, { now: BC(8, 58), pack: pack(yesterday), drive: { pack: nobody.pack, calls: [ST, A, B] } });
    check('drive: with yesterday\'s cached pack the card is yesterday\'s status card', await which(p) === 'st0', await which(p));
    await p.click('#packBtn'); await p.waitForTimeout(700);
    check('drive: today\'s call sheets arrive at 08:58: the auto card goes to Bravo at once, not at 09:00', await which(p) === 'b' && /^Auto: Call Bravo/.test(await autoLabel(p)), [await which(p), await p.textContent('#setStatus')]);
    await p.selectOption('#callSel', 'a'); await p.waitForTimeout(150);
    await p.evaluate(() => { window.__drive.callsTok = 'c2'; }); await setNow(p, BC(9, 10)); await p.waitForTimeout(1800);
    check('drive: a refresh with the same call sheets keeps a hand pick', await which(p) === 'a', await which(p));
    await p.evaluate(() => { window.__drive.callsTok = 'c3'; window.__drive.calls = window.__drive.calls.filter(c => c.id !== 'a'); }); await setNow(p, BC(9, 21)); await p.waitForTimeout(1800);
    check('drive: a refresh that drops the hand-picked card clears the hand pick and re-picks (Bravo running)', await which(p) === 'b' && /^Auto: Call Bravo/.test(await autoLabel(p)), [await which(p), await autoLabel(p)]);
    check('drive: no page errors', p.errors.length === 0, p.errors);
    await p.context().close();
  });

  // a pack swap (setPack: new pack object, calls follow later) must not change or clear the auto card
  await sc('pack swap, delayed call sheets', async () => {
    p = await newPage(browser, { now: BC(8, 44), pack: pack([ST, A, B]), drive: { pack: nobody.pack, calls: [ST, A, B] } });
    check('swap-delay: 08:44 shows Alpha', await which(p) === 'a', await which(p));
    await setNow(p, BC(8, 50)); await p.waitForTimeout(1300);
    await p.evaluate(() => { window.__drive.callsDelay = 2500; });
    await p.click('#packBtn'); await p.waitForTimeout(4200);
    check('swap-delay: at 08:50 a pack swap whose call sheets download slowly keeps Alpha (no jump to Bravo 10 min early)', await which(p) === 'a', await which(p));
    await setNow(p, BC(9, 0)); await p.waitForTimeout(1400);
    check('swap-delay: Bravo only at 09:00', await which(p) === 'b', await which(p));
    check('swap-delay: no page errors', p.errors.length === 0, p.errors);
  });
  await sc('pack swap', async () => {
    p = await newPage(browser, { now: BC(8, 58), pack: pack([ST, A, B]), drive: { pack: nobody.pack, calls: [ST, A, B] } });
    check('swap: before the swap the card is Bravo', await which(p) === 'b');
    await p.click('#packBtn'); await p.waitForTimeout(700);
    check('swap: after the Drive pack replaced the cached one and the call sheets reloaded, still Bravo', await which(p) === 'b', await which(p));
    await p.context().close();
  });

  // ===== (c) + (d): answers and detection =====
  await sc('answers c-d', async () => {
    const detectCfg = [{ text: cand({ line: 3, ask: 'why the report shows one of three parts orders', kind: 'question' }, { line: 1, ask: 'confirm the item is on track', kind: 'question' }) }];
    p = await newPage(browser, { now: BC(9, 1), pack: pack([ST, A, B]), script: { detect: detectCfg, answer: [{ text: ans('ANSWER-ONE') }, { text: ans('ANSWER-TWO') }] } });
    await feedCall(p);
    check('c: the selected card is Bravo before the answer', await which(p) === 'b');
    await p.click('#askedBtn');
    check('d: the newest room question (09:10:20, in the last 2 minutes) is the one answered first', await waitSay(p, 'ANSWER-ONE'), await askSay(p));
    log = await gateLog(p);
    const det = posts(log, 'detect')[0], an = posts(log, 'answer')[0];
    const du = det ? userOf(det) : '';
    check('d: the detect prompt numbers the snapshot and splits it: older [1] [2] first, then THE LAST 2 MINUTES [3] [4]', /\[1\] 09:05:10 Pat Sample/.test(du) && /\[3\] 09:10:20 Doug Example/.test(du) && du.indexOf('OLDER CONTEXT') < du.indexOf('[1] 09:05:10') && du.indexOf('[1] 09:05:10') < du.indexOf('THE LAST 2 MINUTES') && du.indexOf('THE LAST 2 MINUTES') < du.indexOf('[3] 09:10:20'), du);
    check('d: the detect prompt accepts a question to the whole room and prefers the newest', /whole room/.test(du) && /NEWEST/.test(du) && /"candidates"/.test(du), du);
    check('d: the detect request carries no pack and no card (captions context)', det && !/CARDMARK|CURRENT CALL SHEET|CONTEXT PACK/.test(sysOf(det)));
    check('c: the answer request has NO call sheet and NO card text anywhere (system prompt, pack copy included)', an && !/CURRENT CALL SHEET|CARDMARK/.test(sysOf(an)), an && sysOf(an).slice(0, 300));
    check('c: the answer request still has the pack (without its calls)', an && /CONTEXT PACK/.test(sysOf(an)) && !/"calls"/.test(sysOf(an)));
    check('c: the answer request quotes THE LAST MINUTE with times, and the question is in it', an && /THE LAST MINUTE/.test(userOf(an)) && /\[09:10:20\] Doug Example: Our parts order report/.test(userOf(an)) && /Exact caption: "Our parts order report/.test(userOf(an)), an && userOf(an));
    check('d: the card shows the caption line it picked, with speaker and time', /Picked: Doug Example at 09:10:20: "Our parts order report/.test(await p.textContent('#askMore')), await p.textContent('#askMore'));
    check('d: "Not this one" is shown and enabled', await p.isVisible('#notThis') && await p.isEnabled('#notThis'));
    await p.click('#notThis');
    check('d: Not this one tries the previous question (09:05:10) from the same detect call', await waitSay(p, 'ANSWER-TWO') && /Picked: Pat Sample at 09:05:10/.test(await p.textContent('#askMore')), await p.textContent('#askMore'));
    log = await gateLog(p);
    check('d: Not this one sent no second detect, one more answer', posts(log, 'detect').length === 1 && posts(log, 'answer').length === 2, [posts(log, 'detect').length, posts(log, 'answer').length]);
    await p.click('#notThis'); await p.waitForTimeout(200);
    check('d: after the last candidate: "No earlier question found", the button goes away, no wraparound', /No earlier question found/.test(await p.textContent('#askWho')) && await p.isHidden('#notThis') && posts(await gateLog(p), 'answer').length === 2);
    // positive control and the other callers
    await p.click('#briefBtn'); await p.waitForTimeout(700);
    await p.fill('#sayIn', 'update on the sample item'); await p.click('#sayBtn'); await p.waitForTimeout(700);
    await p.click('#explainBtn'); await p.waitForTimeout(700);
    await p.click('#wrapBtn'); await p.waitForTimeout(900);
    log = await gateLog(p);
    const br = posts(log, 'brief')[0], rm = posts(log, 'room')[0], wr = posts(log, 'wrap')[0], sf = posts(log, 'answer')[2];
    check('control: the brief DOES carry the selected card (Bravo only, not Alpha)', br && /CURRENT CALL SHEET/.test(sysOf(br)) && /CARDMARK-b/.test(sysOf(br)) && !/CARDMARK-a/.test(sysOf(br)), br && sysOf(br).slice(-300));
    check('control: "What should I say?" (his own topic) keeps the card, Bravo only', sf && /CARDMARK-b/.test(sysOf(sf)) && !/CARDMARK-a/.test(sysOf(sf)));
    check('ride-along: the room explanation sends no card text', rm && !/CURRENT CALL SHEET|CARDMARK/.test(sysOf(rm)), rm && sysOf(rm).slice(-200));
    check('ride-along: the wrap sends no card text', wr && !/CURRENT CALL SHEET|CARDMARK/.test(sysOf(wr)));
    const stored = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem('sidekick_live_pack')); } catch (e) { return null; } });
    check('PACK in localStorage still has its calls after the answers', stored && Array.isArray(stored.calls) && stored.calls.length === 3, stored && stored.calls && stored.calls.length);
    check('c-d: no page errors', p.errors.length === 0, p.errors);
    await p.context().close();
  });

  // invalid / duplicate line numbers from the model are dropped; the caption text is the page's own
  await sc('bad line numbers', async () => {
    p = await newPage(browser, { now: BC(9, 1), pack: pack([ST, A, B]), script: { detect: [{ text: cand({ line: 99, ask: 'invented', kind: 'question' }, { line: 3, ask: 'real one', kind: 'question' }, { line: 3, ask: 'duplicate', kind: 'question' }) }], answer: [{ text: ans('ANSWER-REAL') }] } });
    await feedCall(p); await p.click('#askedBtn');
    check('d: an out-of-range line is rejected, the real caption is quoted by the page', await waitSay(p, 'ANSWER-REAL') && /Picked: Doug Example at 09:10:20: "Our parts order report/.test(await p.textContent('#askMore')), await p.textContent('#askMore'));
    await p.click('#notThis'); await p.waitForTimeout(200);
    check('d: the duplicate was dropped, so one Not this one ends the list', /No earlier question found/.test(await p.textContent('#askWho')));
    await p.context().close();
  });

  // detect finds nothing
  await sc('no candidates', async () => {
    p = await newPage(browser, { now: BC(9, 1), pack: pack([ST, A, B]), script: { detect: [{ text: cand() }] } });
    await feedCall(p); await p.click('#askedBtn'); await p.waitForTimeout(800);
    check('d: no candidates: the old "No question to you found" text, no answer request', /No question to you found/.test(await p.textContent('#askWho')) && posts(await gateLog(p), 'answer').length === 0);
    await p.context().close();
  });

  // ===== race guard, slow path, failures =====
  // (i) two taps, the first detect is slow: only the newer result is shown, the older one never starts an answer
  await sc('race i', async () => {
    p = await newPage(browser, { now: BC(9, 1), pack: pack([ST, A, B]), script: { detect: [{ text: cand({ line: 1, ask: 'OLD-ASK', kind: 'question' }), delay: 2500 }, { text: cand({ line: 3, ask: 'NEW-ASK', kind: 'question' }) }], answer: [{ text: ans('ANS-NEW') }] } });
    await feedCall(p); await p.click('#askedBtn'); await p.waitForTimeout(300); await p.click('#askedBtn');
    const okNew = await waitSay(p, 'ANS-NEW'); await p.waitForTimeout(3000);
    check('race: a slow first detect and a second tap: only the newer answer is shown, the old detect starts no answer', okNew && await askSay(p) === 'ANS-NEW' && posts(await gateLog(p), 'answer').length === 1 && posts(await gateLog(p), 'detect').length === 2, [await askSay(p), posts(await gateLog(p), 'answer').length]);
    await p.context().close();
  });

  // (ii) a slow OLD answer lands after a newer one: the card keeps the newer, the old goes to the alert list marked as replaced
  await sc('race ii', async () => {
    p = await newPage(browser, { now: BC(9, 1), pack: pack([ST, A, B]), script: { detect: [{ text: cand({ line: 1, ask: 'OLD-ASK', kind: 'question' }) }, { text: cand({ line: 3, ask: 'NEW-ASK', kind: 'question' }) }], answer: [{ text: ans('ANS-OLD'), delay: 2500 }, { text: ans('ANS-NEW') }] } });
    await feedCall(p); await p.click('#askedBtn'); await p.waitForTimeout(500); await p.click('#askedBtn');
    const okNew2 = await waitSay(p, 'ANS-NEW'); await p.waitForTimeout(3000);
    const alerts = await p.textContent('#alertList');
    check('race: a stale answer never replaces the newer one on the card', okNew2 && await askSay(p) === 'ANS-NEW', await askSay(p));
    check('race: the stale answer is kept in the alert list, marked as replaced', /ANS-OLD/.test(alerts) && /replaced this answer/.test(alerts) && /ANS-NEW/.test(alerts), alerts);
    await p.context().close();
  });

  // (iii) New call while an answer is in flight: it never reaches the new call's card or alerts
  await sc('race iii', async () => {
    p = await newPage(browser, { now: BC(9, 1), pack: pack([ST, A, B]), script: { detect: [{ text: cand({ line: 3, ask: 'NEW-ASK', kind: 'question' }) }], answer: [{ text: ans('ANS-LATE'), delay: 2500 }] } });
    await feedCall(p); await p.click('#askedBtn'); await p.waitForTimeout(700);
    await p.click('#newCall'); await p.waitForTimeout(3300);
    check('race: an answer that returns after New call is dropped (card and alert list stay empty)', !/ANS-LATE/.test(await askSay(p)) && !/ANS-LATE/.test(await p.textContent('#alertList')) && /Nothing yet/.test(await p.textContent('#askWho')), [await askSay(p), await p.textContent('#alertList')]);
    await p.context().close();
  });

  // (iv) a caption-triggered check that ends "not for you" must not discard an answer he asked for
  await sc('race iv', async () => {
    p = await newPage(browser, { now: BC(9, 1), pack: pack([ST, A, B]), script: { detect: [{ text: cand({ line: 3, ask: 'NEW-ASK', kind: 'question' }) }, { text: '{"for_me": false, "kind": "", "ask": ""}' }], answer: [{ text: ans('ANS-SLOW'), delay: 2500 }] } });
    await feedCall(p); await p.click('#askedBtn'); await p.waitForTimeout(500);
    await feedAt(p, BC(9, 11, 31), 'k5', 'Pat Sample', 'Harsh, one more thing about the sample item');
    await setNow(p, BC(9, 11, 36)); await p.waitForTimeout(1200);
    const okSlow = await waitSay(p, 'ANS-SLOW');
    check('race: a gate detect that says "not for you" does not kill the manual answer (askGen moves only when answer() runs)', okSlow && posts(await gateLog(p), 'detect').length === 2, [await askSay(p), posts(await gateLog(p), 'detect').length]);
    await p.context().close();
  });

  // slow path: first byte too slow on the detect -> the page's one slower retry, one answer
  await sc('slow detect', async () => {
    p = await newPage(browser, { now: BC(9, 1), pack: pack([ST, A, B]), script: { detect: [{ text: cand({ line: 3, ask: 'NEW-ASK', kind: 'question' }) }], answer: [{ text: ans('ANS-SLOWDET') }] } });
    await feedCall(p); await p.evaluate(() => { window.__gate.plan = ['slowfirst']; });
    await p.click('#askedBtn');
    const okSlowDet = await waitSay(p, 'ANS-SLOWDET', 14000);
    log = await gateLog(p);
    check('slow path: no first byte in 6 s on the detect: one retry with a longer wait, then the answer; the lane is not stopped', okSlowDet && posts(log, 'detect').length === 2 && await p.isHidden('#laneBar'), [await askSay(p), posts(log, 'detect').length]);
    await p.context().close();
  });

  // a single 5xx on the detect: one retry, no lane stop
  await sc('502', async () => {
    p = await newPage(browser, { now: BC(9, 1), pack: pack([ST, A, B]), script: { detect: [{ text: cand({ line: 3, ask: 'NEW-ASK', kind: 'question' }) }], answer: [{ text: ans('ANS-5XX') }] } });
    await feedCall(p); await p.evaluate(() => { window.__gate.plan = ['http502']; });
    await p.click('#askedBtn');
    const ok5 = await waitSay(p, 'ANS-5XX', 9000);
    check('failure: one 502 on the detect: retried once, answered, the lane is not stopped', ok5 && posts(await gateLog(p), 'detect').length === 2 && await p.isHidden('#laneBar'), [await askSay(p), p.errors]);
    await p.context().close();
  });

  // two requests failing together (network error twice): this tap shows its error, the lane stays up, the next tap works
  await sc('two network errors', async () => {
    p = await newPage(browser, { now: BC(9, 1), pack: pack([ST, A, B]), script: { detect: [{ text: cand({ line: 3, ask: 'NEW-ASK', kind: 'question' }) }], answer: [{ text: ans('ANS-AFTER') }] } });
    await feedCall(p); await p.evaluate(() => { window.__gate.plan = ['network', 'network']; });
    await p.click('#askedBtn');
    await p.waitForFunction(() => /Could not read the question/.test(document.getElementById('askWho').textContent), null, { timeout: 12000 }).catch(() => {});
    check('failure: two network errors in a row: the tap shows "Could not read the question", the health probe keeps the lane up', /Could not read the question/.test(await p.textContent('#askWho')) && await p.isHidden('#laneBar'), [await p.textContent('#askWho'), await p.textContent('#laneBar')]);
    await p.click('#askedBtn');
    check('failure: the next tap works', await waitSay(p, 'ANS-AFTER', 9000), await askSay(p));
    check('failure: no page errors', p.errors.length === 0, p.errors);
    await p.context().close();
  });

  await browser.close(); server.close();
  let failed = 0;
  for (const r of results) { console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : '\n  ' + JSON.stringify(r.detail))); if (!r.ok) failed++; }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL harness error', e); process.exit(1); });
