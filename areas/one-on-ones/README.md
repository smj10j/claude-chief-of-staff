# 1:1s

## Folder Structure

Organized by relationship type. Populated during `/init`.

```
one-on-ones/
  direct-reports/    -- people who report to you
  manager/           -- your manager
  peers/             -- peers you meet with regularly
  skip-level/        -- leaders above your manager (strategic relationships)
  skip-level-reports/ -- your reports' reports (skip-level 1:1s)
  xfn/               -- cross-functional partners
```

## Per-Person Notes

### Structure
Each person's folder has two layers:

**README.md** — Persistent context (updated over time, not overwritten per session)
- Role, team, org context
- Working style and interaction patterns
- Key relationships they navigate
- What's generally top of mind for them
- Growth/career context (for direct reports)
- Standing questions to keep in rotation

**sessions/** — Temporal check-in notes (one file per 1:1)
- Named by date: `2026-03-10.md`, `2026-03-17.md`, etc.
- What we discussed
- Action items (theirs and mine)
- Follow-ups for next time
- Any observations or signals worth tracking

### Workflow
1. Before a 1:1: read the README + last session file for context
2. During/after: create a new session file with notes
3. Periodically: update the README if something has shifted (priorities, concerns, career goals)
