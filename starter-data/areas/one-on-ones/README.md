# 1:1s

This folder holds your per-person 1:1 system. Each person gets their own folder containing a `README.md` (persistent context — who they are, what they care about, themes you're tracking) and a `sessions/` subfolder of dated check-in notes.

## Folder structure

```
one-on-ones/
  direct-reports/        # people who report to you
  manager/               # your manager
  peers/                 # peer relationships you actively manage
  skip-level/            # your manager's manager (and up)
  skip-level-reports/    # your reports' reports (and down)
  xfn/                   # cross-functional partners (PM, design, data, etc.)
```

Inside each relationship folder, create a folder per person:

```
direct-reports/
  alice/
    README.md            # persistent context about Alice
    sessions/            # one file per 1:1
      2026-04-22.md
      2026-04-15.md
      ...
```

## Workflow

**Before a 1:1**, run `/prep-1on1 <name>` from Claude Code. The skill reads the README + recent sessions, gathers Slack/task context, and generates a fresh session file with a shared agenda you can paste into a Google Doc.

**After a 1:1**, run `/digest-meeting <name>`. The skill reads any raw notes you took (in the session file or a shared Google Doc), structures them, updates the README with new themes, and proposes task updates.

**Periodically**, the README itself accumulates — old sessions get compacted to summaries (run `/compact-sessions <name>` or wait for `/weekly-review`), and the README captures the through-line of your relationship over time.

## The session file format

Every session file starts with a `## Shared Agenda` section — a tight, copy/paste-ready bullet list you'll drop into the shared Google Doc before the meeting. The full prep (context, coaching notes, follow-ups from last time) lives below. Keep the shared agenda terse so it's a useful jumping-off point for the live conversation, not a wall of text.

## Naming conventions

- Folder names: lowercase, hyphenated (`alice-smith`, not `AliceSmith` or `alice_smith`)
- Session files: ISO date (`2026-04-22.md`)
- Compacted files: `compacted_<period>.md` (e.g., `compacted_2026-Q1.md`)
