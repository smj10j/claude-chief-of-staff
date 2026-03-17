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
For each 1:1 today: prepped or needs prep. If needs prep, offer to run the prep workflow.

### Signals
Anything from Slack/comms that needs attention — threads to respond to, escalations, FYIs.

### Carry-Forward
Items from yesterday that didn't get done and should be rescheduled.

## Rules
- Be concise. This is a morning scan, not a novel.
- Lead with what matters most, not what's first chronologically.
- Always offer to prep any 1:1s that don't have session files yet.
- Always offer to copy any draft messages to clipboard via pbcopy.
- If overdue tasks are piling up, proactively suggest a triage pass.
