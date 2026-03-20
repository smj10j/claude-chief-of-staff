# Morning Briefing

Generate a prioritized daily briefing. Run all data gathering in parallel, then synthesize.

## Data Gathering (run in parallel)

1. **Calendar**: If a calendar integration is available, get today's events. Convert all times to the user's local timezone. Note which are accepted vs. maybe vs. declined.

2. **Tasks**: Read `tasks.yaml` and `recurring.yaml`. Identify:
   - Tasks due today
   - Overdue tasks (past due date)
   - In-progress tasks
   - High-priority tasks without due dates that may need attention

3. **1:1 Prep**: For any 1:1s on today's calendar, check if a session file exists in `areas/one-on-ones/`. If not, flag that prep is needed. If one exists, note the key topics.

4. **Meeting Prep**: For any meetings in `areas/meetings/`, check the README for context.

5. **Signals**: If a Slack/comms integration is available, search for recent activity mentioning you or your teams from yesterday/today. Look for:
   - Direct mentions or DMs that may need response
   - Threads in team channels with activity
   - Any incidents or escalations

6. **Projects**: Scan `projects/INDEX.md` for active projects with upcoming milestones.

## Output Format

### Calendar
Table with: Time | Meeting | Status | Notes (prep needed, conflicts, key context)

### Top Priorities
Numbered list of the 3-5 most important things to focus on today, synthesized from tasks + calendar + signals. Explain WHY each is the top priority (deadline, dependency, opportunity).

### Tasks Due / Overdue
Grouped list. Flag anything that should be re-dated vs. actually done today.

### 1:1 Prep Status
For each 1:1 today: prepped or needs prep. If needs prep, offer to run the prep workflow. **Flag if the other person has not accepted, has declined, or is tentative on the calendar invite** — don't prep for a meeting that may not happen. Also flag any OOO signals from Slack/comms.

### Signals
Anything from Slack/comms that needs attention — threads to respond to, escalations, FYIs.

### Carry-Forward
Items from yesterday that didn't get done and should be rescheduled.

## Auto-Prep: 1:1s and Meetings

After generating the briefing, **automatically prep every 1:1 and tracked meeting on today's calendar**:

### 1:1 Auto-Prep
For each 1:1 on today's calendar where the person has a folder in `areas/one-on-ones/`:
- **Skip if**: the other person has declined or not responded to the invite (flag in the briefing but don't waste time prepping)
- **Skip if**: a session file for today already exists
- **Prep**: Follow the full prep workflow from `/prep-1on1` — read README + last session, gather context, create the session file with Shared Agenda + Prep + Raw Notes sections
- Run all 1:1 preps in parallel using subagents

For 1:1s where the person does NOT have a folder in `areas/one-on-ones/`, note it in the briefing and ask if the user wants to add them.

### Meeting Auto-Prep
For each meeting on today's calendar that matches a folder in `areas/meetings/`:
- **Skip if**: the user has declined
- **Skip if**: a session file for today already exists
- **Prep**: Read the meeting's README + last session, check for any relevant context, create a session file at `areas/meetings/<meeting>/sessions/YYYY-MM-DD.md`

### Auto-Write Briefing File

After generating the briefing (and before starting any prep), write the briefing to:

```
areas/daily-briefings/sessions/YYYY-MM-DD.md
```

This creates a running history of daily briefings, following the same date-based session pattern used for 1:1s and meetings. The file should contain the full briefing output as rendered to the user.

## Rules
- Be concise. This is a morning scan, not a novel.
- Lead with what matters most, not what's first chronologically.
- Always offer to copy any draft messages to clipboard via pbcopy.
- If overdue tasks are piling up, proactively suggest a triage pass.
- Write the briefing file FIRST, then kick off 1:1/meeting preps in parallel.
- Summarize prep results at the end: which 1:1s/meetings were prepped, which were skipped and why.
