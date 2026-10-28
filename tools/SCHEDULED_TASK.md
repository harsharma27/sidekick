# Scheduled task: CMCM live list refresh

The build run on 28 Oct 2026 could not create this task itself: the scheduled-task write was
blocked by the permission check. Create it once from a claude.ai or Cowork chat with
the settings below.

- Name: `CMCM live list refresh`
- Schedule: `CRON_TZ=America/Los_Angeles 0 8-17 * * 1-5` (every hour 8 AM to 5 PM Pacific, weekdays).
  If that form is rejected, use hourly `0 * * * *`. The prompt below exits outside 8 to 17 Pacific on weekdays.
- Notifications: none (`{}`). The prompt sends one push only when a step fails.
- Leave the existing `Morning call notes` task as it is.

Prompt (standalone):

```
Refresh Harsh Sharma's CMCM live list (he is a junior BSA on CMCM Field Service at Illumina; Pacific time).

Hard rules: never send any email, Teams, Jira or chat message; never create, edit or delete Activity Tracker rows (read only); never touch any part of the sidekick-brief Google Doc other than the LIVE LIST block; never touch other scheduled tasks; do not commit anything to the repo.

1. Check the time in America/Los_Angeles. If it is Saturday or Sunday, or earlier than 08:00 or later than 17:59, stop with one line "outside hours".
2. Clone the GitHub repo harsharma27/sidekick (main branch) into the working directory if it is not already there, and pull the latest main.
3. Read tools/RUNBOOK.md and follow it exactly, step by step, using a fresh empty scratch folder as $W and running the script with python3 -I from the repo root. Load tools with ToolSearch as needed (ArtifactData; Google Drive search_files, download_file_content, create_file, get_file_metadata, trash_file; Google Docs read_doc, update_doc).
4. Stop at the first failed step. Do not retry more than the RUNBOOK allows, and do not write anything after a failed step.
5. Finish with one short line: "published" (with fingerprint, section counts, new pack id and bytes), "no change" (doc-plan said skip and the pack size matched), or "failed at step N: <reason>". Only if a step failed, send one push notification with that line.
```

Cost note: when the tracker changes, a run copies the whole pack (about 58 KB) into one
upload call. Runs where nothing changed stop at step 5 and cost little.
