# Weekly Review

Friday GTD-style review. Close out the week, set up the next one.

## Execution Strategy

**Delegate data gathering (Steps 1-4 and 6) to a single Agent.** Launch one Agent that runs all the read-heavy steps below and returns a structured report covering: accomplishments, overdue tasks, project health, 1:1 housekeeping, and recurring items. The Agent should return enough detail for the main conversation to present findings and make triage recommendations.

Step 5 (Next Week Preview) stays in the main conversation since it may use calendar integrations for calendar data.

After the Agent returns, combine its findings with the calendar preview, present the full weekly review, and proceed with triage confirmations.

## Steps (run data gathering in parallel)

### 1. What Got Done
- Run `bash bin/cos task list --archived --since $(date -v-monday +%Y-%m-%d) --format json` for tasks completed this week
- Run `git log --oneline --since="last monday"` to see what changed
- Summarize accomplishments — group by project/area

### 2. Task Triage
- Run `bash bin/cos task list --format json` — identify all overdue tasks
- For each overdue task: recommend re-date, drop, or escalate
- Flag any tasks that have been overdue for more than a week — these need a decision, not another re-date
- Present the list and ask for confirmation before making changes

### 3. Project Health Check
- Read `data/files/projects/INDEX.md` — check active projects
- For each active project, read the README and note: status, next milestone, any blockers
- Flag projects with no activity this week

### 4. 1:1 Housekeeping
- Check `data/files/areas/one-on-ones/` for any READMEs with "Next Session Topics" that haven't been addressed
- Flag any direct reports without a session file this week

### 5. Next Week Preview
- If a calendar integration is available, pull next week's calendar (Monday-Friday)
- Identify: 1:1s that need prep, big meetings, deadlines from task list
- Flag any days that are packed vs. have space for deep work

### 6. Recurring Items
- Run `bash bin/cos task recurring --format json` — anything that needs updating or adding?

## Output Format

### This Week's Wins
Bulleted summary of what got done — good for standup notes or manager updates.

### Task Triage
Table: Task | Due | Recommendation (re-date / drop / do Monday / escalate)
Confirm before making changes.

### Project Status
Table: Project | Status | This Week | Next Action

### Next Week at a Glance
Day-by-day summary: key meetings, 1:1s needing prep, deadlines.

### Housekeeping
Any cleanup actions: archive completed projects, update READMEs, etc.

### 7. Session Compaction

Run the `/compact-sessions` pipeline as part of the weekly review. This keeps session volumes manageable and ensures compaction happens regularly.

1. Run the scan phase — identify all compaction candidates across 1:1s, meetings, and daily briefings
2. Present the summary table in the weekly review output
3. Run verification — check digestion status, follow-ups in task DB, README gaps
4. **Auto-resolve where safe:**
   - Follow-up item exists in the task DB → verified, proceed
   - Follow-up clearly addressed in a subsequent session → verified, proceed
   - README gaps that are factual updates → apply automatically
5. **Flag for user review:**
   - Orphaned action items not found in task DB or subsequent sessions
   - Undigested sessions (still have Raw Notes, no Session Notes)
   - Coaching signals (direct reports) that might need career doc updates
6. Batch all confirmations into a single prompt — present the full list with recommended actions and ask for blanket approval with exceptions (don't ask per-file)
7. Execute compaction for all verified/approved candidates
8. Generate the compaction report for inclusion in the persisted weekly review

### 8. Persist Weekly Review

Save the complete weekly review output as a dated artifact.

1. Determine the Friday date: `date +%Y-%m-%d` (or the most recent Friday if running on another day)
2. Write the full review to `data/files/areas/weekly-reviews/sessions/YYYY-MM-DD.md`
3. The output should include ALL sections from above: Wins, Task Triage, Project Health, 1:1 Housekeeping, Next Week Preview, Compaction Report, Recurring Items, and Housekeeping Actions
4. Commit: `weekly review: YYYY-MM-DD`

After writing the file, print **exactly one final line**:

```
SAVED: data/files/areas/weekly-reviews/sessions/YYYY-MM-DD.md
```

The v2 UI parses this to open the review in the editor. The `SAVED:` line must be the LAST line of the response.

## Rules
- Don't make changes to tasks without confirmation. Present recommendations, then execute.
- Keep the wins section punchy — this is ammo for updates and self-advocacy.
- If overdue tasks are consistently piling up, say so directly. The system isn't working if things keep slipping.
- Session compaction runs AFTER task triage and project health — those steps may resolve orphaned items that compaction would otherwise flag.
- When running via scheduled cron (Friday 8 PM), auto-resolve safe items and defer flagged items to the persisted report for Monday review. Don't block on confirmations in unattended mode.
