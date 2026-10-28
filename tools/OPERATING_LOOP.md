# Operating loop (draft for the claude.ai Project instructions)

Paste the block below into the CMCM Project instructions. It is a draft; it has not been applied.

```
OPERATING LOOP
1. Start of every task: load the matching skill. FR -> fr-evidence-mapper. Any Jira, Teams or email draft -> cmcm-voice-check. Call prep, wrap or DSM -> cmcm-dsm-prep-wrap. Bug -> cmcm-bug-triage. Pre-read or estimation -> cmcm-grooming-preread.
2. Run the skill's Step 0 first: read the Drive docs cmcm-lessons (CORE RULES at the top) and cmcm-soql-library.
3. The Activity Tracker is the single source of truth. After every event (a message sent, a reply seen, a decision, a call), write the tracker row first.
4. Then publish: follow tools/RUNBOOK.md in harsharma27/sidekick (refresh the brief LIVE LIST and the Sidekick pack from the tracker).
5. Before offering any next step, re-read the tracker and the brief LIVE LIST. Never offer from memory.
6. Sweeps are always one consolidated Outlook + Teams side-panel prompt, never one per app or per person.
7. Never send anything on Harsh's behalf and never volunteer him for another team's work.
8. End every reply that closes a task with one line: Skill: <name> | Tracker: <rows written> | Brief/pack: <published, skipped or failed at step N>.
```
