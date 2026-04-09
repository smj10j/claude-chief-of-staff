# Morning Briefing

Generate a prioritized daily briefing. Run all data gathering in parallel, then synthesize.

## Data Gathering (run in parallel)

1. **Calendar**: If a calendar integration is available, get today's events. Convert all times to the user's local timezone. Note which are accepted vs. maybe vs. declined.

2. **Tasks**: Run `bash bin/db/task-cli.sh list --format json` and `bash bin/db/task-cli.sh recurring --format json`. The JSON output includes a computed `isOverdue` field. Identify:
   - Tasks due today (with times, if set - partition into time-specific vs. end-of-day)
   - Overdue tasks (use the `isOverdue` field - this is time-aware for tasks with due times)
   - In-progress tasks
   - High-priority tasks without due dates that may need attention

3. **1:1 Prep**: For any 1:1s on today's calendar, check if a session file exists in `data/files/areas/one-on-ones/`. If not, flag that prep is needed. If one exists, note the key topics.

4. **Meeting Prep**: For any meetings in `data/files/areas/meetings/`, check the README for context.

5. **Signals**: If a Slack/comms integration is available, search for recent activity mentioning you or your teams from yesterday/today. Look for:
   - Direct mentions or DMs that may need response
   - Threads in team channels with activity
   - Any incidents or escalations

6. **Projects**: Scan `data/files/projects/INDEX.md` for active projects with upcoming milestones.

7. **Mobile Captures**: Run `bash bin/reminders/apple-reminders.sh list`. If non-empty, include in briefing. If the adapter fails (permission denied, compilation error), log the error as a note rather than failing the entire briefing. Run this in parallel with the other data gathering steps — it takes ~1.5s.

## Output Format

### Calendar
Table with: Time | Meeting | Status | Notes (prep needed, conflicts, key context)

### Top Priorities
Numbered list of the 3-5 most important things to focus on today, synthesized from tasks + calendar + signals. Explain WHY each is the top priority (deadline, dependency, opportunity).

### Mobile Captures
If `bin/reminders/apple-reminders.sh list` returned pending reminders, display them:

```markdown
## Mobile Captures (N pending)

| # | Reminder | Due | Notes |
|---|----------|-----|-------|
| 1 | Follow up with Alex on threshold changes | - | - |
| 2 | Book dentist appointment | Apr 5 | Re: crown |

Run `/review-reminders` to import.
```

If no pending reminders, omit this section entirely. If the adapter failed, include a brief note (e.g., "Mobile Captures: adapter error — Reminders access denied") but don't fail the briefing.

### Tasks Due / Overdue
Grouped list. If any tasks have specific due times (due field contains `YYYY-MM-DD HH:MM`), list them under a **Time-specific** sub-heading in chronological order with the time shown (e.g., `09:00 - Prep for 1:1`). Tasks due today without a specific time go under **By end of day**. Flag anything that should be re-dated vs. actually done today.

### 1:1 Prep Status
For each 1:1 today: prepped or needs prep. If needs prep, offer to run the prep workflow. **Flag if the other person has not accepted, has declined, or is tentative on the calendar invite** — don't prep for a meeting that may not happen. Also flag any OOO signals from Slack/comms.

### Signals
Anything from Slack/comms that needs attention — threads to respond to, escalations, FYIs.

### Carry-Forward
Items from yesterday that didn't get done and should be rescheduled.

## Execution Order

The workflow runs in three phases:

### Phase 1 — Data Gathering
Run all data gathering (calendar, tasks, Slack/comms, projects) in parallel. Identify which 1:1s and meetings need prep.

### Phase 2 — Prep 1:1s and Meetings
Before writing the briefing, **prep every 1:1 and tracked meeting on today's calendar**. This ensures the briefing reflects what was actually prepped and can include key topics from each session file.

#### 1:1 Auto-Prep
For each 1:1 on today's calendar where the person has a folder in `data/files/areas/one-on-ones/`:
- **Skip if**: the other person has declined or not responded to the invite (flag in the briefing but don't waste time prepping)
- **Skip if**: a session file for today already exists
- **Prep**: Follow the full prep workflow from `/prep-1on1` — read README + last session, gather context, create the session file with Shared Agenda + Prep + Raw Notes sections
- Run all 1:1 preps in parallel using subagents

For 1:1s where the person does NOT have a folder in `data/files/areas/one-on-ones/`, note it in the briefing and ask if the user wants to add them.

#### Meeting Auto-Prep
For each meeting on today's calendar that matches a folder in `data/files/areas/meetings/`:
- **Skip if**: the user has declined
- **Skip if**: a session file for today already exists
- **Prep**: Read the meeting's README + last session, check for any relevant context, create a session file at `data/files/areas/meetings/<meeting>/sessions/YYYY-MM-DD.md`

### Phase 3 — Write and Deliver the Briefing
After all preps are complete, write the full briefing to:

```
data/files/areas/daily-briefings/sessions/YYYY-MM-DD.md
```

The briefing should:
- Reference each prepped 1:1/meeting by name with key topics pulled from the session files
- Mark each as "Prepped" (with session file path) or "Skipped" (with reason) in the 1:1 Prep Status table
- Include a summary of what was prepped at the bottom

This creates a running history of daily briefings, following the same date-based session pattern used for 1:1s and meetings.

## Rules
- Be concise. This is a morning scan, not a novel.
- Lead with what matters most, not what's first chronologically.
- Always offer to copy any draft messages to clipboard via pbcopy.
- If overdue tasks are piling up, proactively suggest a triage pass.
- Prep FIRST, then write the briefing — so the briefing is the final, complete picture of the day.
- **Always include file links** when referencing repo items. Prepped 1:1s and meetings should link to their session files. Projects should link to their folder or `data/files/projects/INDEX.md`. The briefing should be a clickable hub.
- **Relative link paths**: The briefing file lives at `data/files/areas/daily-briefings/sessions/YYYY-MM-DD.md` (5 levels deep from repo root). All relative links must account for this depth:
  - To sibling `areas/` folders (one-on-ones, meetings): `../../one-on-ones/...`, `../../meetings/...`
  - To projects: `../../../projects/...`
  - To repo root files: `../../../../../CLAUDE.md`
  - **Do NOT use `../` — that only goes up to `daily-briefings/`, not to `areas/`.** Count from `data/files/areas/daily-briefings/sessions/` every time.
