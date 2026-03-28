# Weekly Review

Friday GTD-style review. Close out the week, set up the next one.

## Execution Strategy

**Delegate data gathering (Steps 1-4 and 6) to a single Agent.** Launch one Agent that runs all the read-heavy steps below and returns a structured report covering: accomplishments, overdue tasks, project health, 1:1 housekeeping, and recurring items. The Agent should return enough detail for the main conversation to present findings and make triage recommendations.

Step 5 (Next Week Preview) stays in the main conversation since it may use calendar integrations for calendar data.

After the Agent returns, combine its findings with the calendar preview, present the full weekly review, and proceed with triage confirmations.

## Steps (run data gathering in parallel)

### 1. What Got Done
- Run `bash data/task-cli.sh list --archived --since $(date -v-monday +%Y-%m-%d) --format json` for tasks completed this week
- Run `git log --oneline --since="last monday"` to see what changed
- Summarize accomplishments — group by project/area

### 2. Task Triage
- Run `bash data/task-cli.sh list --format json` — identify all overdue tasks
- For each overdue task: recommend re-date, drop, or escalate
- Flag any tasks that have been overdue for more than a week — these need a decision, not another re-date
- Present the list and ask for confirmation before making changes

### 3. Project Health Check
- Read `projects/INDEX.md` — check active projects
- For each active project, read the README and note: status, next milestone, any blockers
- Flag projects with no activity this week

### 4. 1:1 Housekeeping
- Check `areas/one-on-ones/` for any READMEs with "Next Session Topics" that haven't been addressed
- Flag any direct reports without a session file this week

### 5. Next Week Preview
- If a calendar integration is available, pull next week's calendar (Monday-Friday)
- Identify: 1:1s that need prep, big meetings, deadlines from task list
- Flag any days that are packed vs. have space for deep work

### 6. Recurring Items
- Run `bash data/task-cli.sh recurring --format json` — anything that needs updating or adding?

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

## Rules
- Don't make changes to tasks without confirmation. Present recommendations, then execute.
- Keep the wins section punchy — this is ammo for updates and self-advocacy.
- If overdue tasks are consistently piling up, say so directly. The system isn't working if things keep slipping.
