---
allowed-tools: mcp__claude_ai_Atlassian__getJiraIssue, mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql, Read, Write, Bash(mkdir:*)
description: Draft a weekly plan-update narrative for one epic (PRD-110 §5.5)
---

# /planning-epic-update <epic-key>

Take an epic key (e.g. `EXAMPLE-1234`) and draft a short weekly
plan-update narrative the manager can paste into a Slack channel,
a status doc, or the epic's Confluence page.

## What to write

Path: `data/files/areas/planning/updates/<epic-key>-<date>.md`

Body:

```
# <Epic title>  ·  <epic-key>

**Status:** <traffic light> — <one-line summary>

## Wins this week
- ...

## Risks / blockers
- ...

## What's planned next
- ...

## Asks
- ...

---

[Open in Jira](<url>) · last updated <relative>
```

## How to gather signal

1. `getJiraIssue(<key>)` for title, status, assignee, due date,
   description.
2. JQL `parent = <key> AND updated >= -7d ORDER BY updated DESC`
   for last week's child-ticket activity.
3. JQL `parent = <key> AND status = Blocked` for current blockers.
4. If a `linked` field references a PRD/TDD doc, glance at it for
   scope phrasing.

## Output discipline

- `mkdir -p` parent.
- Print exactly: `SAVED: data/files/areas/planning/updates/<epic-key>-<date>.md`
- Empty / error path writes a stub with a TODO list of missing
  prereqs (epic key invalid, MCP unauthed, etc.).
