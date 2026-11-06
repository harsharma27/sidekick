# Live list publish RUNBOOK

Publishes Harsh's CMCM state from the tracker to the two places that read it:
the Drive brief LIVE LIST block and the Sidekick context pack (`sidekick-pack.json`).

Rules for whoever runs this (a person or a Claude session):

- The Activity Tracker is the single source of truth. Read it. Never write to it.
- Never send email, Teams or Jira messages. Never touch any other part of the brief.
- Run the steps in order. **Stop at the first failed step** and report which step and why.
  Nothing is written before step 6, so a failure in steps 1 to 5 leaves the old brief and
  pack untouched.
- No work data goes into this repo. Work files live only in the run's scratch folder `$W`.

IDs

| What | ID |
|---|---|
| Tracker | private repo `harsharma27/cmcm-tracker`, file `tracker.log` (event log; replay with `tools/tracker_log.py`). The claude.ai artifact `1FCGiFDQmJqfD8a9bQmuYp` is a frozen read-only archive since 6 Nov 2026: never read it for live state |
| Brief (Google Doc) | `1gsEmxOtWEeuXBIMz6NP-atAcFaJ_5QnXfwqRAWj3S9I` |
| Drive folder (pack lives here) | `1uE4jqez2KWso72d1MR8oEL0eb6Q0nGHV` |

## Steps

Set `W` to an empty scratch folder (for example `$SCRATCH/live`; `mkdir -p "$W"`).
Run the script from the repo root with `python3 -I tools/build_live.py ...`.

1. **Export the tracker.** Attach the private repo first: `mcp__claude-code-remote__add_repo`
   with owner `harsharma27`, repo `cmcm-tracker`, access `read` (load it with ToolSearch if
   needed). Then `git clone --depth 1 https://github.com/harsharma27/cmcm-tracker "$W/trk"` and
   `python3 -I tools/tracker_log.py replay "$W/trk/tracker.log" "$W/export"`.
   Pass: the replay prints `"ok": true` with `rows` above 100. If the repo cannot be attached or
   cloned, or the replay refuses (exit 2), stop: nothing has been written. Never fall back to the
   frozen claude.ai artifact.

2. **Get the current pack.** `Google_Drive search_files` with query
   `parentId = '1uE4jqez2KWso72d1MR8oEL0eb6Q0nGHV' and title = 'sidekick-pack.json'`,
   `excludeContentSnippets: true`. Take the newest by `createdTime`; note every id found.
   `download_file_content` on the newest. Write its `content` string (base64) exactly as
   returned into `$W/old_pack.b64`, with the Write tool. Then:
   `python3 -I tools/build_live.py static $W/old_pack.b64 $W/static.json`
   Pass: prints `"ok": true` with people and stories counts above 0.
   (Only the part before `"items"` is used; me / voice / people / stories are carried over unchanged.)

3. **Build.** `python3 -I tools/build_live.py build $W/export $W/static.json $W/out`
   Pass: prints meta JSON. Note `fingerprint` and `pack_bytes`. Outputs:
   `$W/out/sidekick-pack.json` (pure ASCII) and `$W/out/live_list.txt`.

4. **Read the brief.** `Google_Docs read_doc` with documentId = brief. The result is large
   and is saved to a file; use that file path as `$DOC`. (If it comes back inline instead,
   write the whole JSON result to `$W/doc_before.json` and use that.)

5. **Plan the brief edit.** `python3 -I tools/build_live.py doc-plan $DOC $W/out`
   - `"action": "refuse"` (exit 2): stop. The brief has no `CURRENT STATE` heading, or its
     LIVE LIST has no `END LIVE LIST` line and is longer than 3 paragraphs. Report it.
   - `"action": "skip"`: the brief already shows this exact tracker state today. Do not write
     the brief. Go to step 7 only to check the pack: if the newest pack's `fileSize` equals
     `pack_bytes`, the run is finished with "no change"; otherwise do steps 7 to 9.
   - `"action": "write"`: continue. `$W/out/doc_requests.json` holds the exact request.

6. **Write the brief.** `Google_Docs update_doc` with `documentId` = brief and the
   `requests` and `writeControl` from `$W/out/doc_requests.json`, copied exactly
   (one `deleteContentRange` for the old block, if any, then one `insertText` at the same
   index with the full text of `live_list.txt`; `requiredRevisionId` = the revision read in
   step 4). If it fails because the revision changed, go back to step 4 once; a second
   failure stops the run.
   The block written is: `LIVE LIST, generated <time> Pacific from the tracker (fingerprint ...)`
   then TODAY, TOMORROW, WAITING ON OTHERS, DONE TODAY, ALSO OPEN ON HARSH, and the line
   `END LIVE LIST`. If the brief had no LIVE LIST, it is inserted right under the first
   `CURRENT STATE` heading. Text outside the block is never touched.

7. **Upload the pack.** `Google_Drive create_file` with `title: "sidekick-pack.json"`,
   `parentId` = folder, `contentMimeType: "application/json"`,
   `disableConversionToGoogleType: true`, and `textContent` = the full content of
   `$W/out/sidekick-pack.json` copied exactly (Read the file; it is pure ASCII with one value per line, newlines included, and ends with a newline).
   Pass: the returned `fileSize` equals `pack_bytes`. If not, `trash_file` the new file
   (so the previous pack stays the newest) and stop.

8. **Trash older packs.** For every `sidekick-pack.json` id found in step 2 (all of them are
   older than the new file): `trash_file`. Do not rely on a fresh search here: Drive search
   can take several minutes to index a new file, so a search right after the upload may
   return nothing. A pack missed by search lag gets trashed on the next run. live.html always
   loads the newest pack by `createdTime`, so an older one left behind is harmless.

9. **Read back and verify.**
   - `read_doc` the brief again (saved to a file `$DOC2`), then
     `python3 -I tools/build_live.py verify-doc $DOC2 $W/out` must print `"ok": true`.
   - `get_file_metadata` on the new pack id: `title` is `sidekick-pack.json`, `parentId` is the
     folder, `fileSize` equals `pack_bytes`. `get_file_metadata` on each trashed id is not
     needed; `trash_file` returning `{}` is success.

## Report

One short summary: step reached, `fingerprint`, section counts from the build meta,
brief written or skipped, new pack id and bytes, packs trashed. On a failure: the step,
the error, and confirmation that nothing after it was written.

## Notes

- BC time is `America/Vancouver` (permanent UTC-7; `America/Los_Angeles` is an hour behind in winter). TODAY = open or waiting items whose due or chase
  date is today or earlier; TOMORROW = next weekday; WAITING ON OTHERS = court is not Harsh
  and no date soon; DONE TODAY = status done and updated today (Pacific). Parked items are left out.
- Pack items = open and waiting items, plus done items updated in the last 2 days, each with the
  last 5 log lines clipped to 460 characters.
- The fingerprint covers the tracker items and today's date, so an unchanged tracker on the
  same day is a no-op.

## Writing to the tracker (interactive sessions only; scheduled tasks never write)

Clone or pull `harsharma27/cmcm-tracker`, then for each change run, from the sidekick repo root:
`python3 -I tools/tracker_log.py append <clone>/tracker.log <row> <SET|LOG|NEW> '<json>'`
(SET = changed fields, never `log`; LOG = one `{"d","t"}` line; NEW = a whole new row). A refusal
(exit 2) leaves the file untouched. Then `git -C <clone> commit -am "<row>: <what>"` and
`git -C <clone> push`; if the push is rejected, `git pull --rebase` once and push again.
