// Mock of the hub's door gate, SHARED by tests/fix_test.js, tests/lane_test.js and tests/live_test.js (23 Nov 2026: lane_test.js's own copy of initGate was deleted; the two were identical except the script hook below).
// Optional hooks: window.__gate.script (set by initScripted) lets a test choose the text, the delay and the finish_reason (`finish`, default 'stop') of a reply per task; without it the mock behaves as the original lane_test.js mock did.
// Usage: await page.addInitScript(initGate); then optionally await page.addInitScript(initScripted, cfg).
// The mock runs INSIDE the page (it wraps fetch for the gate URL): Playwright serialises these functions, so they must not use anything outside themselves.

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
      if (mode === 'ok' && typeof g.script === 'function') {   // optional per-test replies (see initScripted)
        const r = g.script(body);
        if (r) { const send = () => resolve(okResponse(model, { pieces: [sse(chunkObj(r.text, { choices: [{ delta: { content: r.text }, finish_reason: r.finish || 'stop' }] })), sse({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), 'data: [DONE]\n\n'] })); return r.delay ? setTimeout(send, r.delay) : send(); }
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

// cfg: { detect: [ {text, delay?, finish?}, ... ], answer: [...], ... } = a queue of replies per task (the gate request's metadata.hub_task is 'sidekick-<task>'). An empty queue falls through to the normal mock.
function initScripted(cfg) {
  const q = {}; Object.keys(cfg || {}).forEach(k => { q[k] = cfg[k].slice(); });
  window.__gate.script = (body) => {
    const t = body && body.metadata && String(body.metadata.hub_task || '').replace(/^sidekick-/, '');
    return t && q[t] && q[t].length ? q[t].shift() : null;
  };
}
module.exports = { initGate, initScripted };
