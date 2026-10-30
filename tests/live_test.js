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
   "function driveSave(name,text){ window.__saves=(window.__saves||[]); window.__saves.push(name); return new Promise(function(r){setTimeout(r,300)});"],
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

  check('No page errors', errors.length === 0, errors);
  await b.close();

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : '  ' + JSON.stringify(r.detail)}`);
    if (!r.ok) failed++;
  }
  console.log(failed ? `${failed} check(s) failed: do not commit live.html` : 'All checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL run: ' + e.message); process.exit(1); });
