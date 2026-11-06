# Tests

## live_test.js (Sidekick Live regression test)

**Run before every commit that touches `live.html`. Do not commit if it fails.**

```
node tests/live_test.js
```

It builds a mock harness from the current `live.html` at run time (Drive save and the
Anthropic API are mocked, nothing leaves the machine), then checks:

| Check | Guards against |
|---|---|
| Save clicked 4 times fast writes one wrap file | duplicate wraps in Drive (29 Oct) |
| ... and one transcript file | duplicate transcripts in Drive (29 Oct) |
| New call ignores captions Teams resends from the old call | old call bleeding into the new one (29 Oct) |
| New call keeps a new caption that reuses an old id | over-filtering after the fix |
| Teams re-sends a caption under a new id: no duplicate line | doubled transcript blocks (2 Nov DSM) |
| No page errors | script breaks |
| Failing AI: at most 3 API hits in 8 s | retry storm that burned the 200-call cap with 0 tokens (2 Nov DSM) |
| Failing AI: failures not counted as calls, shown on the pill | cap reached by failures; error hidden |
| A saved usage count made only of failed calls does not keep the cap blocked | page still capped after reload on 2 Nov |
| A reply that hits the length limit is retried with more room; the full wrap is shown and saved | 435-byte cut-off wrap saved to Drive (3 Nov PBR) |
| A reply that keeps hitting the limit: at most 3 tries, shown with a "Cut short" note | a cut-off wrap passing as complete |
| An open "does anybody know how this works?" question to the room shows a chip-in explanation, not an "Asked of you" alert | silent Sidekick while Chancey asked how picklist order works (3 Nov PBR) |
| The tracker rule (never invent status, owners, dates or decisions) is still in the rules, with platform mode as a labelled exception | general knowledge leaking into tracker answers |
| Ordinary chatter on a big call makes no AI call | cost and noise from the new trigger |
| "Explain the last question" answers the latest question even when the trigger missed it | missed questions with no way to ask |
| Model id with a "/" goes to OpenRouter, with no-retention routing, Claude not called | sk03 multi-model (5 Nov) |
| OpenRouter reply cut short is retried with more room | truncated replies (3 Nov PBR pattern) |
| OpenRouter fails twice: rest of the call uses the Claude fallback model, shown on the pill; New call resets | a hypercare call depending on a new provider (5 Nov) |
| Same OpenRouter id in both boxes: the wrap falls back to the answer model, not the fast one | openrouter/auto in both boxes (6 Nov DSM) |

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
