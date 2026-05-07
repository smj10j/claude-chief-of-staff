# Recurring meetings

This folder holds your recurring meetings (not 1:1s — those live in `../one-on-ones/`). Each meeting gets a folder with `README.md` (attendees, standing agenda, persistent context) and a `sessions/YYYY-MM-DD.md` log per occurrence.

## Folder pattern

```
meetings/
  staff-meeting/
    README.md            # who attends, what's the standing agenda, key context
    sessions/
      2026-04-22.md
      2026-04-15.md
  cross-functional-sync/
    README.md
    sessions/
      ...
```

## Workflow

**Before a meeting**, read the README + the most recent session file. Optionally run `/digest-meeting <slug>` against the prior session to refresh context.

**After a meeting**, capture notes in a fresh `sessions/YYYY-MM-DD.md` file. Run `/digest-meeting <slug>` to structure raw notes, update the README with new themes, and propose follow-up tasks.

**Periodically**, run `/compact-sessions` (or let `/weekly-review` do it) to keep the session log from growing unbounded.
