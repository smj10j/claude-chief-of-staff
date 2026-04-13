# Task Triage

Surface and manage overdue or stale tasks. Quick cleanup pass.

## Steps

### 1. Load Tasks
- Run `bash bin/db/task-cli.sh list --format json` and identify:
  - **Overdue**: due date is in the past
  - **Stale**: no due date and priority is low, or has been sitting with no updates
  - **Due soon**: due within the next 3 days

### 2. Present for Review
Write the full triage output to `data/files/areas/task-triage/triage.md`. **Overwrite** the file each time — this is transient working data, not a history.

Also print a summary to the terminal so the user can review and respond inline if they prefer.

Group tasks into these sections:

**DROP or ARCHIVE** — Table: Task | Due | Why Drop
Tasks that are stale, overtaken by events, or duplicates.

**MARK DONE** — Table: Task | Due | Why Done
Tasks that have been completed but not marked.

**RE-DATE** — Grouped by timeframe (this week, next week, later). Table: Task | Old Due | New Due | Rationale
For each, suggest a realistic new due date based on calendar and workload.

**DUE SOON** — Table: Task | Due | Status
Flag any that look at risk of slipping.

**NO DUE DATE** — Table: Task | Recommendation
Tasks that need a due date or should be moved to someday/maybe.

End the file with: `Mark up this file in the UI with your changes, then tell Claude to process it.`

The user can respond either inline in the terminal or via UI annotations — support both flows.

### 3. Execute Changes
After the user reviews and confirms (either via UI annotations or verbally):
- Use `bash bin/db/task-cli.sh update <id>` to update due dates
- Use `bash bin/db/task-cli.sh done <id>` or `bash bin/db/task-cli.sh archive <id>` for completed/dropped tasks
- Use `bash bin/db/task-cli.sh update <id> --notes "..."` to add context

### 4. Summary
Show what changed: how many re-dated, dropped, completed, still overdue.

## Rules
- Never change tasks without confirmation first. Present the plan, get approval, then execute.
- Be honest about pile-up. If the same tasks keep getting re-dated, call it out.
- Personal tasks (tagged `personal`) get lighter treatment — just ask if they still matter.
- When suggesting new due dates, check the calendar to avoid stacking everything on a packed day.
