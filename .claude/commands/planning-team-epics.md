---
allowed-tools: mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql, Read, Write, Bash(mkdir:*)
description: Snapshot epics owned by the user's team for the Roadmap tab (PRD-110)
---

# /planning-team-epics

Fetch the open epics owned by the user's team. The Projects →
Roadmap tab (B8-CP24) renders this list as cards by status and uses
it to compute epic health (B8-CP25).

## What to write

Path: `data/files/areas/planning/epics.json`

Shape:

```json
{
  "fetched_at": "2026-04-25T17:30:00Z",
  "team": "string",
  "epics": [
    {
      "key": "EXAMPLE-1234",
      "title": "string",
      "status": "To Do" | "In Progress" | "Done" | "...",
      "category": "To Do" | "In Progress" | "Done",
      "url": "https://<your-org>.atlassian.net/browse/EXAMPLE-1234",
      "owner": "string?",
      "due": "YYYY-MM-DD" | null,
      "updated": "ISO 8601",
      "tickets_total": 0,
      "tickets_done": 0,
      "tickets_blocked": 0,
      "labels": []
    }
  ]
}
```

## How to query

1. Take `$ARGUMENTS` as the team key. If empty, default to
   `<your-team>` (or read the user's `myTeam` from
   `data/files/areas/ops/team.txt` if it exists).
2. JQL search for `issuetype = Epic AND "Team[Team]" = "<team>"
   AND statusCategory != Done ORDER BY updated DESC`. Cap to 30.
3. For each epic, fetch counts of child issues by status category
   (use a follow-up JQL `parent = <key>` count query). Compute
   `tickets_blocked` from `parent = <key> AND statusCategory != Done
   AND priority IN (Highest, High) AND status = "Blocked"`.

## Output discipline

- `mkdir -p` parent.
- Atomic write.
- One line: `SAVED: data/files/areas/planning/epics.json`
- Empty / error path writes `{"epics": [], "mcp_error": "..."}`.
