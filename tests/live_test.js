// Sidekick live.html regression test. Run from the repo root before committing any live.html change:
//   node tests/live_test.js
// Exit code 0 = all checks passed; 1 = a check failed (do not commit).
// Builds a mock harness from the CURRENT live.html at run time (Drive save and Anthropic API mocked),
// so the test never drifts from the page it is testing.
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright');

const SRC = path.join(__dirname, '..', 'live.html');
let html = fs.readFileSync(SRC, 'utf8');

// Each patch must match exactly once, or the test fails loudly (the page changed shape: update the patch).
const patches = [
  ['function driveSave(name,text){',
   "function driveSave(name,text){ window.__saves=(window.__saves||[]); window.__saves.push(name); (window.__saveTexts=window.__saveTexts||{})[name]=text; return new Promise(function(r){setTimeout(r,300)});"],
  [' if(!OK.test(ev.origin)) return;', ' '],
  [' if(driveLive()) go(); else connectDrive(go);', ' go();'],
];
for (const [from, to] of patches) {
  const n = html.split(from).length - 1;
  if (n !== 1) { console.log(`FAIL harness: expected 1 match for ${JSON.stringify(from)}, found ${n}`); process.exit(1); }
  html = html.replace(from, to);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-test-'));
const harness = path.join(dir, 'harness.html');
fs.writeFileSync(harness, html);

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('dialog', d => d.accept());
  await p.route('https://api.anthropic.com/**', async r => {
    await new Promise(x => setTimeout(x, 200));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'WRAP TEXT' }], usage: { input_tokens: 1, output_tokens: 1 } }) });
  });
  await p.addInitScript(() => {
    localStorage.setItem('sidekick_live', JSON.stringify({ apikey: 'x', gcid: 'y', gfolder: 'z', names: 'Harsh', mFast: 'f', mSmart: 's', cap: 200 }));
  });
  await p.goto('file://' + harness);

  // Scenario 1: wrap, then Save clicked 4 times fast -> exactly one wrap file and one transcript file.
  const caps = [];
  for (let i = 0; i < 5; i++) caps.push({ id: 'c' + i, author: 'Colleague, Test', text: 'old call line ' + i });
  await p.evaluate(c => window.postMessage({ sk: 'cap1', caps: c }, '*'), caps);
  await p.waitForTimeout(300);
  await p.click('#wrapBtn');
  await p.waitForTimeout(600);
  for (let i = 0; i < 4; i++) await p.evaluate(() => document.getElementById('saveWrap').click());
  await p.waitForTimeout(1200);
  const saves = await p.evaluate(() => (window.__saves || []).slice());
  const wraps = saves.filter(s => /wrap/i.test(s)).length;
  const txs = saves.filter(s => /transcript/i.test(s)).length;
  check('Save x4 writes one wrap', wraps === 1, saves);
  check('Save x4 writes one transcript', txs === 1, saves);

  // Scenario 2: New call, Teams resends old captions (same ids), then a new caption with a recycled id.
  await p.click('#newCall');
  await p.waitForTimeout(200);
  await p.evaluate(c => window.postMessage({ sk: 'cap1', caps: c }, '*'), caps);
  await p.waitForTimeout(200);
  await p.evaluate(() => window.postMessage({ sk: 'cap1', caps: [{ id: 'c1', author: 'Colleague, Other', text: 'new call first line' }] }, '*'));
  await p.waitForTimeout(300);
  const tx = await p.textContent('#tx');
  check('New call ignores old captions', !/old call line/.test(tx), tx.slice(0, 200));
  check('New call keeps new caption with recycled id', /new call first line/.test(tx), tx.slice(0, 200));

  // Scenario 3: Teams re-sends captions already shown, under new ids -> no duplicate lines.
  const before = await p.evaluate(() => document.getElementById('txCount').textContent);
  await p.evaluate(() => window.postMessage({ sk: 'cap1', caps: [{ id: 'z9', author: 'Colleague, Other', text: 'new call first line' }] }, '*'));
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => document.getElementById('txCount').textContent);
  check('Re-sent caption with a new id is not duplicated', before === after, { before, after });

  check('No page errors', errors.length === 0, errors);

  // Scenario 4: the AI API keeps failing -> no retry storm, failures not counted as calls, pause shown.
  const p2 = await b.newPage();
  const errs2 = [];
  p2.on('pageerror', e => errs2.push(e.message));
  let apiHits = 0;
  await p2.route('https://api.anthropic.com/**', async r => { apiHits++; await r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'invalid x-api-key' } }) }); });
  await p2.addInitScript(() => {
    localStorage.setItem('sidekick_live', JSON.stringify({ apikey: 'x', gcid: 'y', gfolder: 'z', names: 'Harsh', mFast: 'f', mSmart: 's', cap: 200 }));
  });
  await p2.goto('file://' + harness);
  const many = []; for (let i = 0; i < 60; i++) many.push({ id: 'm' + i, author: 'Speaker ' + (i % 4), text: 'status line number ' + i + ' about the release' });
  await p2.evaluate(c => window.postMessage({ sk: 'cap1', caps: c }, '*'), many);
  await p2.waitForTimeout(8000);
  const pill = await p2.textContent('#aiPill');
  check('Failing AI: no retry storm (at most 3 API hits in 8 s)', apiHits <= 3, { apiHits });
  check('Failing AI: failed calls not counted toward the cap', /AI: 0 calls today/.test(pill), pill);
  check('Failing AI: failures shown on the pill', /failed/.test(pill), pill);
  check('Failing AI: no page errors', errs2.length === 0, errs2);
  // Scenario 5: a saved usage count made only of failed calls (old version) does not keep the cap blocked after reload.
  const p3 = await b.newPage();
  await p3.addInitScript(() => {
    localStorage.setItem('sidekick_live', JSON.stringify({ apikey: 'x', gcid: 'y', gfolder: 'z', names: 'Harsh', mFast: 'f', mSmart: 's', cap: 200 }));
    const d = new Date(); const pad = n => (n < 10 ? '0' : '') + n;
    localStorage.setItem('sidekick_live_usage', JSON.stringify({ day: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), calls: 200, inTok: 0, cacheTok: 0, outTok: 0 }));
  });
  await p3.goto('file://' + harness);
  const pill3 = await p3.textContent('#aiPill');
  check('Old failed-only usage no longer blocks the cap', /AI: 0 calls today/.test(pill3) && /200 failed/.test(pill3), pill3);

  // Scenario 6: the wrap reply hits the length limit once -> retried with more room, full wrap shown and saved (3 Nov PBR: 435-byte wrap saved).
  const mkPage = async (handler) => {
    const pg = await b.newPage();
    const errs = []; pg.on('pageerror', e => errs.push(e.message)); pg.on('dialog', d => d.accept());
    const reqs = [];
    await pg.route('https://api.anthropic.com/**', async r => { const body = JSON.parse(r.request().postData() || '{}'); reqs.push(body.max_tokens); await r.fulfill(handler(reqs.length, body)); });
    await pg.addInitScript(() => { localStorage.setItem('sidekick_live', JSON.stringify({ apikey: 'x', gcid: 'y', gfolder: 'z', names: 'Harsh', mFast: 'f', mSmart: 's', cap: 200 })); });
    await pg.goto('file://' + harness);
    await pg.evaluate(c => window.postMessage({ sk: 'cap1', caps: c }, '*'), [{ id: 'w1', author: 'Colleague, Test', text: 'wrap test line' }]);
    await pg.waitForTimeout(300);
    return { pg, errs, reqs };
  };
  const reply = (text, stop) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ model: 'm', stop_reason: stop, content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } }) });
  const s6 = await mkPage((n) => n === 1 ? reply('PARTIAL WRAP', 'max_tokens') : reply('FULL WRAP TEXT', 'end_turn'));
  await s6.pg.click('#wrapBtn');
  await s6.pg.waitForTimeout(1500);
  const out6 = await s6.pg.textContent('#wrapOut');
  await s6.pg.evaluate(() => document.getElementById('saveWrap').click());
  await s6.pg.waitForTimeout(900);
  const saves6 = await s6.pg.evaluate(() => (window.__saves || []).slice());
  check('Cut-short wrap is retried with more room', s6.reqs.length === 2 && s6.reqs[1] > s6.reqs[0], s6.reqs);
  check('Cut-short wrap: the full wrap is shown, not the partial', out6.trim() === 'FULL WRAP TEXT', out6);
  check('Cut-short wrap: Save writes one wrap after the retry', saves6.filter(s => /wrap/i.test(s)).length === 1, saves6);
  check('Cut-short wrap: no page errors', s6.errs.length === 0, s6.errs);

  // Scenario 7: every reply hits the length limit -> at most 3 tries, partial shown with a clear "cut short" note.
  const s7 = await mkPage(() => reply('STILL PARTIAL', 'max_tokens'));
  await s7.pg.click('#wrapBtn');
  await s7.pg.waitForTimeout(2000);
  const out7 = await s7.pg.textContent('#wrapOut');
  check('Always cut short: at most 3 tries', s7.reqs.length <= 3, s7.reqs);
  check('Always cut short: the wrap is marked as cut short', /STILL PARTIAL/.test(out7) && /Cut short/.test(out7), out7);

  // Scenario 8: an open question to the room about how the platform works (3 Nov PBR, Chancey on picklist order)
  // -> room card explains it; nothing lands in "Asked of you"; tracker rules stay strict.
  const room = JSON.stringify({ relevant: true, explain: 'ROOM EXPLAIN', say: 'ROOM SAY', check: 'ROOM CHECK', confidence: 'high' });
  const mkRoom = async () => {
    const pg = await b.newPage();
    const errs = []; pg.on('pageerror', e => errs.push(e.message));
    const bodies = [];
    await pg.route('https://api.anthropic.com/**', async r => { const body = r.request().postData() || ''; bodies.push(body); await r.fulfill(reply(/PLATFORM MODE/.test(body) ? room : '{"for_me": false}', 'end_turn')); });
    await pg.addInitScript(() => { localStorage.setItem('sidekick_live', JSON.stringify({ apikey: 'x', gcid: 'y', gfolder: 'z', names: 'Harsh', mFast: 'f', mSmart: 's', cap: 200 })); });
    await pg.goto('file://' + harness);
    const crowd = []; for (let i = 0; i < 6; i++) crowd.push({ id: 'p' + i, author: 'Person ' + i + ', Big', text: 'general discussion line number ' + i });
    await pg.evaluate(c => window.postMessage({ sk: 'cap1', caps: c }, '*'), crowd);
    await pg.waitForTimeout(300);
    return { pg, errs, bodies };
  };
  const s8 = await mkRoom();
  const ask8 = await s8.pg.textContent('#askWho');
  await s8.pg.evaluate(() => window.postMessage({ sk: 'cap1', caps: [{ id: 'q1', author: 'Thompson, Chancey', text: 'Does anybody know, or can educate me on how this list order kind of works?' }] }, '*'));
  await s8.pg.waitForTimeout(5000); // lines are checked once they have been stable for 2.5 s
  const roomA8 = await s8.pg.textContent('#roomA'), roomSay8 = await s8.pg.textContent('#roomSay');
  check('Room question: explanation shown in the chip-in card', /ROOM EXPLAIN/.test(roomA8) && /ROOM CHECK/.test(roomA8) && /ROOM SAY/.test(roomSay8), { roomA8, roomSay8 });
  check('Room question: sent in platform mode', s8.bodies.some(x => /PLATFORM MODE/.test(x)), s8.bodies.length);
  check('Room question: no "Asked of you" alert', (await s8.pg.textContent('#askWho')) === ask8, await s8.pg.textContent('#askWho'));
  const sys8 = s8.bodies.length ? JSON.parse(s8.bodies[0]).system[0].text : '';
  check('Tracker rule unchanged: never invent status, owners, dates or decisions', /Never invent status, owners, dates or decisions/.test(sys8) && /PLATFORM MODE only/.test(sys8), sys8.slice(0, 80));
  check('Current-state rule: "now" and "court" win over older log lines', /"now" field/.test(sys8) && /win over any older log line/.test(sys8), sys8.slice(0, 80));

  // Scenario 9: ordinary chatter on a big call -> no AI call at all.
  const s9 = await mkRoom();
  await s9.pg.evaluate(() => window.postMessage({ sk: 'cap1', caps: [{ id: 'c9', author: 'Wegener, Hanna', text: 'Thanks everyone, that was helpful, talk to you all tomorrow.' }] }, '*'));
  await s9.pg.waitForTimeout(4000);
  check('Ordinary chatter: no AI call', s9.bodies.length === 0, s9.bodies.length);

  // Scenario 10: the Explain button answers the last question even when the trigger missed it.
  await s9.pg.evaluate(() => window.postMessage({ sk: 'cap1', caps: [{ id: 'c10', author: 'Katagi, Sachin', text: 'So the yellow ones are enabled for that type?' }] }, '*'));
  await s9.pg.waitForTimeout(400);
  const before10 = s9.bodies.length;
  await s9.pg.click('#explainBtn');
  await s9.pg.waitForTimeout(1000);
  check('Explain button: answers the last question', s9.bodies.length === before10 + 1 && /ROOM EXPLAIN/.test(await s9.pg.textContent('#roomA')) && /yellow ones/.test(await s9.pg.textContent('#roomQ')), await s9.pg.textContent('#roomQ'));
  check('Room questions: no page errors', s8.errs.length === 0 && s9.errs.length === 0, s8.errs.concat(s9.errs));

  // Scenario 11 (5 Nov 2026, sk03): model ids with a "/" go to OpenRouter with no-retention routing; Claude is not called.
  const orPage = async (orHandler) => {
    const pg = await b.newPage();
    const errs = []; pg.on('pageerror', e => errs.push(e.message)); pg.on('dialog', d => d.accept());
    const orBodies = [], anBodies = [];
    await pg.route('https://openrouter.ai/**', async r => { const body = JSON.parse(r.request().postData() || '{}'); orBodies.push(body); await r.fulfill(orHandler(orBodies.length, body)); });
    await pg.route('https://api.anthropic.com/**', async r => { anBodies.push(JSON.parse(r.request().postData() || '{}')); await r.fulfill(reply('CLAUDE WRAP', 'end_turn')); });
    await pg.addInitScript(() => { localStorage.setItem('sidekick_live', JSON.stringify({ apikey: 'x', orkey: 'k', gcid: 'y', gfolder: 'z', names: 'Harsh', mFast: 'openai/fast', mSmart: 'openai/smart', cap: 200 })); });
    await pg.goto('file://' + harness);
    await pg.evaluate(c => window.postMessage({ sk: 'cap1', caps: c }, '*'), [{ id: 'o1', author: 'Colleague, Test', text: 'openrouter test line' }]);
    await pg.waitForTimeout(300);
    return { pg, errs, orBodies, anBodies };
  };
  const orReply = (text, fin) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ model: 'openai/smart', choices: [{ finish_reason: fin, message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 1000, completion_tokens: 5 } }) });
  const s11 = await orPage(() => orReply('OR WRAP', 'stop'));
  await s11.pg.click('#wrapBtn');
  await s11.pg.waitForTimeout(1200);
  const w11 = s11.orBodies.find(x => x.model === 'openai/smart');
  check('OpenRouter: wrap answered by the "/" model', (await s11.pg.textContent('#wrapOut')).trim() === 'OR WRAP' && !!w11, s11.orBodies.map(x => x.model));
  check('OpenRouter: no-retention routing sent on every call', s11.orBodies.length > 0 && s11.orBodies.every(x => x.provider && x.provider.data_collection === 'deny'), s11.orBodies.map(x => x.provider));
  check('OpenRouter: Claude not called', s11.anBodies.length === 0, s11.anBodies.length);
  check('OpenRouter: usage shown on the pill', /OpenRouter \d+k in/.test(await s11.pg.textContent('#aiPill')), await s11.pg.textContent('#aiPill'));

  // Scenario 12: OpenRouter cut short once -> retried with more room.
  const s12 = await orPage((n) => n === 1 ? orReply('PART', 'length') : orReply('FULL OR WRAP', 'stop'));
  await s12.pg.click('#wrapBtn');
  await s12.pg.waitForTimeout(1500);
  check('OpenRouter cut short: retried with more room', s12.orBodies.length >= 2 && s12.orBodies[1].max_tokens > s12.orBodies[0].max_tokens && (await s12.pg.textContent('#wrapOut')).trim() === 'FULL OR WRAP', s12.orBodies.map(x => x.max_tokens));

  // Scenario 13: OpenRouter keeps failing -> after 2 failures the call switches to the Claude fallback model; New call resets.
  const s13 = await orPage(() => ({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'no providers' } }) }));
  await s13.pg.click('#wrapBtn');
  await s13.pg.waitForTimeout(4500);
  const pill13 = await s13.pg.textContent('#aiPill');
  check('OpenRouter down: wrap still answered by Claude', (await s13.pg.textContent('#wrapOut')).trim() === 'CLAUDE WRAP', await s13.pg.textContent('#wrapOut'));
  check('OpenRouter down: fallback is the Claude answer model', s13.anBodies.length >= 1 && s13.anBodies.every(x => x.model === 'claude-sonnet-5-5'), s13.anBodies.map(x => x.model));
  check('OpenRouter down: at most 2 OpenRouter tries before switching', s13.orBodies.length <= 2, s13.orBodies.length);
  check('OpenRouter down: shown on the pill', /OpenRouter down/.test(pill13), pill13);
  await s13.pg.click('#newCall');
  await s13.pg.waitForTimeout(200);
  check('OpenRouter down: New call goes back to OpenRouter', !/OpenRouter down/.test(await s13.pg.textContent('#aiPill')), await s13.pg.textContent('#aiPill'));
  check('OpenRouter: no page errors', s11.errs.length === 0 && s12.errs.length === 0 && s13.errs.length === 0, s11.errs.concat(s12.errs, s13.errs));

  // Scenario 14 (6 Nov 2026): the same OpenRouter id in both boxes (openrouter/auto) -> the wrap still falls back to the answer model.
  const s14 = await b.newPage();
  const errs14 = []; s14.on('pageerror', e => errs14.push(e.message)); s14.on('dialog', d => d.accept());
  const an14 = [];
  await s14.route('https://openrouter.ai/**', r => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'no providers' } }) }));
  await s14.route('https://api.anthropic.com/**', async r => { an14.push(JSON.parse(r.request().postData() || '{}')); await r.fulfill(reply('CLAUDE WRAP', 'end_turn')); });
  await s14.addInitScript(() => { localStorage.setItem('sidekick_live', JSON.stringify({ apikey: 'x', orkey: 'k', gcid: 'y', gfolder: 'z', names: 'Harsh', mFast: 'openrouter/auto', mSmart: 'openrouter/auto', cap: 200 })); });
  await s14.goto('file://' + harness);
  await s14.evaluate(c => window.postMessage({ sk: 'cap1', caps: c }, '*'), [{ id: 'a1', author: 'Colleague, Test', text: 'auto router test line' }]);
  await s14.waitForTimeout(300);
  await s14.click('#wrapBtn');
  await s14.waitForTimeout(4500);
  check('Same id in both boxes: wrap falls back to the answer model (Sonnet), not Haiku', an14.length >= 1 && an14.every(x => x.model === 'claude-sonnet-5-5') && (await s14.textContent('#wrapOut')).trim() === 'CLAUDE WRAP', an14.map(x => x.model));
  check('Same id in both boxes: no page errors', errs14.length === 0, errs14);

  // Scenario 15 (6 Nov 2026 follow-up call): the same ask repeated by Pawan and Pratyush within 2 minutes
  // -> one gate check per 15 s using the newest line, one answer, one alert marked "asked again".
  const s15 = await b.newPage();
  const errs15 = []; s15.on('pageerror', e => errs15.push(e.message));
  let gates15 = 0, answers15 = 0;
  await s15.route('https://api.anthropic.com/**', async r => {
    const body = r.request().postData() || '';
    if (/Is Harsh being asked a question/.test(body)) { gates15++; return r.fulfill(reply('{"for_me": true, "kind": "question", "ask": "can CM and FS do the work order component placement together"}', 'end_turn')); }
    if (/Give him what to say now/.test(body)) { answers15++; return r.fulfill(reply('{"say": "SAY ONE"}', 'end_turn')); }
    return r.fulfill(reply('{"for_me": false}', 'end_turn'));
  });
  await s15.addInitScript(() => { localStorage.setItem('sidekick_live', JSON.stringify({ apikey: 'x', gcid: 'y', gfolder: 'z', names: 'Harsh', mFast: 'f', mSmart: 's', cap: 200 })); });
  await s15.goto('file://' + harness);
  const rep15 = [
    { id: 'd1', author: 'Mangoli, Pawan', text: 'Harsh, can we coordinate and do the work order placement together?' },
    { id: 'd2', author: 'Mangoli, Pawan', text: 'Or is it OK for us to place that component on the work order, Harsh?' },
    { id: 'd3', author: 'Sahu, Pratyush', text: 'Harsh, what is your thought on doing the placement together?' },
  ];
  for (const c of rep15) { await s15.evaluate(x => window.postMessage({ sk: 'cap1', caps: [x] }, '*'), c); await s15.waitForTimeout(1200); }
  await s15.waitForTimeout(22000);
  const list15 = await s15.textContent('#alertList');
  const n15 = (list15.match(/Say: /g) || []).length;
  check('Repeated ask: at most 2 gate checks for 3 lines in 4 s', gates15 >= 1 && gates15 <= 2, gates15);
  check('Repeated ask: one answer call', answers15 === 1, answers15);
  check('Repeated ask: one alert, marked asked again', n15 === 1 && /Asked 2 times/.test(list15), list15.slice(0, 300));
  check('Repeated ask: no page errors', errs15.length === 0, errs15);

  // Scenario 16 (6 Nov 2026): the bookmark reports the Teams tab hidden -> warning on the pill, and the
  // saved transcript ends with a capture-health line naming the hidden span; an old bookmark gets a note.
  const s16 = await b.newPage();
  const errs16 = []; s16.on('pageerror', e => errs16.push(e.message)); s16.on('dialog', d => d.accept());
  await s16.route('https://api.anthropic.com/**', r => r.fulfill(reply('WRAP16', 'end_turn')));
  await s16.addInitScript(() => { localStorage.setItem('sidekick_live', JSON.stringify({ apikey: 'x', gcid: 'y', gfolder: 'z', names: 'Harsh', mFast: 'f', mSmart: 's', cap: 200 })); });
  await s16.goto('file://' + harness);
  const msg16 = (hidden, caps) => s16.evaluate(m => window.postMessage(m, '*'), { sk: 'cap1', v: 12, hidden, caps });
  await msg16(false, [{ id: 'h1', author: 'Colleague, Test', text: 'first line while Teams is visible' }]);
  await s16.waitForTimeout(600);
  for (let i = 0; i < 4; i++) { await msg16(true, [{ id: 'h1', author: 'Colleague, Test', text: 'first line while Teams is visible' }]); await s16.waitForTimeout(700); }
  const pill16 = await s16.textContent('#capPill');
  await msg16(false, [{ id: 'h2', author: 'Colleague, Test', text: 'second line after Teams is visible again' }]);
  await s16.waitForTimeout(1200);
  const pill16b = await s16.textContent('#capPill');
  await s16.click('#wrapBtn'); await s16.waitForTimeout(800);
  await s16.evaluate(() => document.getElementById('saveWrap').click()); await s16.waitForTimeout(900);
  const tx16 = await s16.evaluate(() => { const o = window.__saveTexts || {}; const k = Object.keys(o).find(n => /transcript/.test(n)); return k ? o[k] : ''; });
  check('Teams hidden: pill warns to keep Teams visible', /Teams hidden \d+ s/.test(pill16), pill16);
  check('Teams visible again: pill back to live', /Captions: live/.test(pill16b), pill16b);
  check('Saved transcript ends with capture health naming the hidden span', /capture health: bookmark v12; Teams hidden 1 time\(s\)/.test(tx16), tx16.slice(-200));
  const s16b = await b.newPage(); const errs16b = []; s16b.on('pageerror', e => errs16b.push(e.message));
  await s16b.addInitScript(() => { localStorage.setItem('sidekick_live', JSON.stringify({ apikey: 'x', gcid: 'y', gfolder: 'z', names: 'Harsh', mFast: 'f', mSmart: 's', cap: 200 })); });
  await s16b.goto('file://' + harness);
  await s16b.evaluate(m => window.postMessage(m, '*'), { sk: 'cap1', v: 11, caps: [{ id: 'o1', author: 'A, B', text: 'old bookmark line' }] });
  await s16b.waitForTimeout(400);
  check('Old bookmark: note to update it', /Update the Sidekick bookmark/.test(await s16b.textContent('#banner')), await s16b.textContent('#banner'));
  check('Capture health: no page errors', errs16.length === 0 && errs16b.length === 0, errs16.concat(errs16b));
  await b.close();

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : '  ' + JSON.stringify(r.detail)}`);
    if (!r.ok) failed++;
  }
  console.log(failed ? `${failed} check(s) failed: do not commit live.html` : 'All checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL run: ' + e.message); process.exit(1); });
