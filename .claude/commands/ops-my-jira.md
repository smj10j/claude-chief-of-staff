---
allowed-tools: mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql, mcp__claude_ai_Atlassian__atlassianUserInfo, Read, Write, Bash(mkdir:*)
description: Snapshot Jira issues currently assigned to me (PRD-109 §5 / B8-CP22)
---

# /ops-my-jira

Snapshot the Jira issues assigned to the current user that are not
yet Done. Powers the Work → Jira tab.

## What to write

Path: `data/files/areas/work/my-jira.json`

Shape:

```json
{
  "fetched_at": "2026-04-25T17:30:00Z",
  "issues": [
    {
      "key": "EXAMPLE-1234",
      "title": "string",
      "status": "In Progress" | "To Do" | "...",
      "priority": "High" | "Medium" | "Low" | "Highest" | "Lowest" | null,
      "type": "Story" | "Bug" | "Task" | "Epic" | "...",
      "due": "YYYY-MM-DD" | null,
      "updated": "ISO 8601",
      "url": "https://<your-org>.atlassian.net/browse/EXAMPLE-1234",
      "epic_key": "string?",
      "labels": []
    }
  ]
}
```

## How to query

1. Resolve the user's accountId via `atlassianUserInfo`.
2. JQL: `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`.
3. Cap to 50 results. Read summary, status, priority, issuetype,
   duedate, updated, parent (epic), labels.

## Output discipline

- `mkdir -p` the parent.
- Atomic write.
- Print exactly: `SAVED: data/files/areas/work/my-jira.json`

If the Atlassian MCP isn't installed / authed, write a valid file
with `issues: []` + `mcp_error`.
