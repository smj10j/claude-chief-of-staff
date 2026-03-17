# Task Triage

Surface and manage overdue or stale tasks. Quick cleanup pass.

## Steps

### 1. Load Tasks
- Read `tasks.yaml` and identify:
  - **Overdue**: due date is in the past
  - **Stale**: no due date and priority is low, or has been sitting with no updates
  - **Due soon**: due within the next 3 days

### 2. Present for Review
Group tasks into three buckets:

**Overdue** — Table: Task | Due Date | Days Overdue | Notes
For each, suggest one of:
- **Re-date**: suggest a new realistic due date based on calendar and workload
- **Do today**: if it's small and important
- **Drop**: if it's no longer relevant
- **Delegate**: if someone else should own it
- **Escalate**: if it's blocked and needs help

**Due Soon** — Table: Task | Due Date | Status | Notes
Flag any that look at risk of slipping.

**Stale** — Tasks with no due date that may need attention or should be dropped.

### 3. Execute Changes
After confirming decisions:
- Update due dates in `tasks.yaml`
- Move dropped/completed tasks to `tasks-archive.yaml` under the current week
- Update any notes with new context

### 4. Summary
Show what changed: how many re-dated, dropped, completed, still overdue.

## Rules
- Never change tasks without confirmation first. Present the plan, get approval, then execute.
- Be honest about pile-up. If the same tasks keep getting re-dated, call it out.
- Personal tasks (tagged `personal`) get lighter treatment — just ask if they still matter.
- When suggesting new due dates, check the calendar to avoid stacking everything on a packed day.
