# Tests

## live_test.js (Sidekick Live regression test)

**Run before every commit that touches `live.html`. Do not commit if it fails.**

```
node tests/live_test.js
```

It builds a mock harness from the current `live.html` at run time. The page is LANE ONLY since 10 Nov 2026, so the model path is the shared work-lane gate mock (`tests/gate_mock.js`, scripted
replies per task keyed by the request's `metadata.hub_task`), Drive is mocked in the page (`driveSave` patched for the wrap file, the 11 Nov call-store uploads recorded for the transcript, a `window.google`
stub), and every request that leaves the page is recorded and aborted by a Playwright route guard, with a CSP-violation recorder beside it. Every page is opened through one helper that always installs these mocks.
Every scenario runs inside `sc()` (a throw is one FAIL and the run goes on), a control page proves the guard records a known forbidden request, and a check-count floor catches a scenario that stopped early.
Output is check names and PASS/FAIL only. All names and captions are invented. Checks:

| Check | Guards against |
|---|---|
| Save clicked 4 times fast writes one wrap file | duplicate wraps in Drive (29 Oct) |
| ... and creates one transcript file (the call store, 11 Nov) | duplicate transcripts in Drive (29 Oct) |
| New call (Drive signed out: tap "clear anyway") ignores captions Teams resends from the old call | old call bleeding into the new one (29 Oct) |
| New call keeps a new caption that reuses an old id | over-filtering after the fix |
| Teams re-sends a caption under a new id: no duplicate line | doubled transcript blocks (2 Nov DSM) |
| Failing gate: 1 to 3 gate chat calls in 8 s | retry storm that burned the 200-call cap with 0 tokens (2 Nov DSM) |
| Failing gate: failed calls not counted as calls, shown on the pill | cap reached by failures; error hidden |
| A saved usage count made only of failed calls does not keep the cap blocked | page still capped after reload on 2 Nov |
| A reply that hits the length limit is retried with more room (the first request is routing.json's wrap value); the full wrap is shown and saved | 435-byte cut-off wrap saved to Drive (3 Nov PBR) |
| A reply that keeps hitting the limit: 2 to 3 wrap calls, shown with a "Cut short" note | a cut-off wrap passing as complete |
| An open "does anybody know how this works?" question to the room shows a chip-in explanation in platform mode, not an "Asked of you" alert | silent Sidekick on a how-it-works question put to the room (3 Nov PBR) |
| The tracker rule (never invent status, owners, dates or decisions) and the current-state rule ("now" and "court" win) are still in the rules | general knowledge leaking into tracker answers; a cheaper model inventing a status (6 Nov) |
| Ordinary chatter on a big call makes no gate call | cost and noise from the new trigger |
| "Explain the last question" answers the LATEST question (an earlier one exists) | missed questions with no way to ask |
| The same ask repeated within 2 minutes gives 1 to 2 gate checks, one answer and one alert marked "asked again" | 6 alerts in 2 min with conflicting say-lines (6 Nov follow-up call) |
| Bookmark v12 reports a hidden Teams tab: pill warns, the saved transcript ends with a capture-health line; an old bookmark (v11) gets an update note | 3-4 min caption gaps when Teams was in a background tab (5 Nov PBR, 6 Nov DSM) |
| Per page: no page errors, and nothing was sent or attempted to any host other than the mocked gate | a stray fetch, a key sent to the wrong host |

### Retired checks (live_test.js, 23 Nov 2026): never restore them

The page has no OpenRouter path, no Anthropic path and no fallback. These checks were retired, not ported, and must never be made to pass by restoring what they tested.

| Old check | Retired by | Successor |
|---|---|---|
| OpenRouter: wrap answered by the "/" model | 10 Nov lane-only change (model ids and boxes purged) | lane_test "Lane: wrap went to the gate chat-completions as work-sonnet, streaming" |
| OpenRouter: no-retention routing (data_collection deny) on every call | 10 Nov lane-only change; zero retention is enforced by the hub door, not provable in a browser mock | none - removed by the 10 Nov lane-only change |
| OpenRouter: Claude not called | NO FALLBACK (9 Nov) | every page's "nothing was sent or attempted to any host other than the mocked gate" check |
| OpenRouter: usage shown on the pill | 10 Nov lane-only change | lane_test "Lane: usage pill counts the call" |
| OpenRouter cut short: retried with more room | 10 Nov lane-only change (one retry path) | "Cut-short wrap is retried with more room" |
| OpenRouter down: wrap still answered by Claude; fallback is the Claude answer model; at most 2 OpenRouter tries; shown on the pill; New call goes back to OpenRouter | MEETING SIDEKICK / NO FALLBACK (9 Nov): when the hub cannot be reached the page says so and stops answering for that call | lane_test "Transport <mode>: ..." (stops for the call, 1 to 2 gate chat calls, nothing sent elsewhere, banner, Retry hub, New call probes again and the lane answers) |
| OpenRouter: no page errors | scenario removed | per-page "no page errors" checks |
| Same id in both boxes: falls back to Sonnet, not Haiku; no page errors | model boxes purged 10 Nov; Claude fallback removed by NO FALLBACK (9 Nov) | lane_test "Purge: apikey, orkey, path, mFast and mSmart are gone" |

## build_live_test.py (pack builder)

`python3 -I tests/build_live_test.py`: each pack item carries "now" (newest log line, clipped to 700), keeps the last 5 log lines, and carries court.

Verified to fail on the pre-fix page (2 Nov checks: on 889510f, 8 API hits in 8 s and a duplicated caption)
and earlier checks on the pre-fix page (commit 8d9a177: 4 wraps, 4 transcripts, old captions kept)
and pass on the fixed page (3a515e3). 3 Nov cut-short checks fail on ac132ec (only 1 try at 4000 tokens, partial wrap shown) and pass after the fix. 3 Nov room-question checks fail on 0dba7d0 (no chip-in card) and pass after the change.

If a harness patch reports "expected 1 match", `live.html` changed shape around Drive save,
the message origin check or the Drive connect call: update the patch in `live_test.js`, never
delete the check. When a new Sidekick bug is fixed, add a check for it here in the same commit.

## wfo_plan_test.py (WFO story plan builder)

**Run before every commit that touches `tools/wfo_plan.py`.**

```
python3 -I tests/wfo_plan_test.py
```

Synthetic exports only. Checks that a cut-off Jira CSV (a row shorter than the header) stops the build
with exit 2, writes no workbook and reports no DROPPED stories (4 Nov 2026: a cut-off all-fields export
would have shown CMCM-48928, CMCM-49795 and CMCM-49957 as dropped), and that a story that really left
the epic is still reported with where it went. 6 of 7 checks fail on the pre-fix script.

## lane_static_test.py and lane_test.js (work lane, 9 Nov 2026; lane_test.js ported to the lane-only page 23 Nov 2026)

Run both before every commit that touches `live.html` or `routing.json`:

```
python3 -I tests/lane_static_test.py
node tests/lane_test.js        # needs playwright; the gate and Drive are mocked in the page, every other request is recorded and aborted
```

**KNOWN STALE until backlog B1 is done: `lane_static_test.py` still checks the removed direct path (at least 6 checks fail on the current page, for example `api.anthropic.com`, `id="apikey"`, `id="pathDirect"`).
Its exit code is red for stale reasons, so READ ITS OUTPUT BY HAND: in particular the line `no key-shaped string in any repo file` must say PASS before a commit. Do not treat the suite as a gate until B1.**
`lane_static_test.py` (no browser): the `innerHTML` count stays 0; the CSP meta and `connect-src`; the page calls `GATE+'/v1/chat/completions'` in OpenAI format; `routing.json` equals the copy built into the page; no key-shaped string anywhere in the repo.

`lane_test.js` (browser, lane only, NO FALLBACK since 9 Nov): old direct-path settings in a browser are purged on load (apikey, orkey, path, mFast, mSmart) and the page has no key field; the lane request shape, key, streaming and `routing.json`
limits (max_tokens is read from the served routing.json, and from `DEFAULT_ROUTING` in live.html when routing.json is rejected); SSE chunks split mid-line; every `refused:` shape is shown as "blocked by the work-lane rule" or "switched off", is never retried,
and never stops the lane; when the hub cannot be reached (network error, 502, 504, 5xx without `refused:`: two in a row, then the health probe also fails) the lane STOPS for the call: the wrap, the banner, the header and Retry hub say so,
the second tap sends nothing, and New call (Drive signed out: tap "clear anyway") or Retry hub probes the hub again and the lane answers; a slow first byte gets ONE retry at double the wait and is not a stop; a break after the first byte, a gate 429, 401
and 403 do NOT stop the lane; the page-start probe, the hub key field, test mode (synthetic captions, Drive blocked) and a real CSP block. Every page also asserts "nothing was sent or attempted to any host other than the mocked gate",
backed by a control page that proves the guard records a known forbidden request.

### Retired checks (lane_test.js, 23 Nov 2026): never restore them

| Old check | Retired by |
|---|---|
| Path toggle shows direct; header "(direct)"; toggle to lane without a hub key; toggle back to direct | the path toggle was removed by the 10 Nov lane-only change |
| Transport failure: fallback count stored; the next probe carries x-sk-fallbacks 1 | NO FALLBACK (9 Nov): there is no fallback, so no count; the header is always 0 (checked in "Lane: x-sk-fallbacks is always 0") |
| Transport failure with no Anthropic key says so | NO FALLBACK (9 Nov): no Anthropic key exists on the page |

Inverted (the old check demanded the fallback; the new one demands the stop): "answered by Anthropic direct", "banner names the direct fallback", "the rest of the meeting stays direct", "header shows direct while down",
"no first byte falls back to direct", "probe failure at page start: banner and direct", "the first call goes direct".

### Negative runs

The ported and inverted checks were each shown FAILING on a deliberately broken copy of `live.html` (33 mutants, one or two anchored edits each, run on a scratch copy, never in the repo); the ledger and the runner live OUTSIDE this repo in the hub session's build folder.
A ported check that no mutant fails does not count. Not automated yet: the suites run only when someone runs them (backlog B5).

## Rule and rollback (906, 23 Nov 2026)

Never delete a check to make a suite pass, and never make a retired fallback check pass by restoring a direct path or a fallback (MEETING SIDEKICK / NO FALLBACK, 9 Nov).
**Rollback:** a plain `git revert` of the port would put the old tests back, which demand the removed fallback, AND would put real names and call lines back into this public repo. A revert must keep the invented fixtures
(revert the logic hunks only, or revert and re-apply the name replacement) and must NEVER be "fixed" by restoring the removed fallback. The gate_mock `finish` line is backward compatible and can stay.

## fix_test.js and gate_mock.js (call card and live answers, 20 Nov 2026)

Run before every commit that touches the call-card pick, `answer()`, the "I've been asked" detect or `laneSystem` in `live.html`:

```
node tests/fix_test.js        # needs playwright; the gate, Drive and Google sign-in are mocked in the page, the clock is faked in the page
node tests/lane_test.js       # tests/gate_mock.js is the ONE gate mock, shared by fix_test.js, lane_test.js and live_test.js (optional `finish` per scripted reply)
```

Covers: the auto card on load / New call / pack refresh / a later call's start (half-open windows, soonest next start within 15 min, running call with the latest start, status card and timeless cards never chosen, no-match
state), a hand pick that holds until New call or the "Auto" entry, no list rebuild while it has focus, the answer request with no call sheet and no card text, THE LAST MINUTE block, the numbered detect snapshot with the last
2 minutes split in code, line numbers validated by the page, "Not this one" (no second detect, no wraparound), the stale-result guards (askGen, detGen, callGen), and the slow path (no first byte, one 502, two network errors) for the detect.
`tests/live_test.js` and `tests/lane_test.js` were ported to the lane-only page on 23 Nov 2026 and run green on the same mock.
