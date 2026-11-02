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

Verified to fail on the pre-fix page (2 Nov checks: on 889510f, 8 API hits in 8 s and a duplicated caption)
and earlier checks on the pre-fix page (commit 8d9a177: 4 wraps, 4 transcripts, old captions kept)
and pass on the fixed page (3a515e3).

If a harness patch reports "expected 1 match", `live.html` changed shape around Drive save,
the message origin check or the Drive connect call: update the patch in `live_test.js`, never
delete the check. When a new Sidekick bug is fixed, add a check for it here in the same commit.
