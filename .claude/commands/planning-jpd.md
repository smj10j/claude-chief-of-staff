---
allowed-tools: mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql, Read, Write, Bash(mkdir:*)
description: Snapshot Jira Product Discovery items for the Roadmap → Discovery sub-tab (PRD-110 §5.3)
---

# /planning-jpd

Fetch the JPD (Jira Product Discovery) ideas the user's team has
in flight. Powers Projects → Roadmap → Discovery (B9-CP21).

## What to write

Path: `data/files/areas/planning/jpd.json`

Shape:

```json
{
  "fetched_at": "2026-04-25T17:30:00Z",
  "team": "string",
  "ideas": [
    {
      "key": "JPD-1234",
      "title": "string",
      "status": "string",
      "score": 0.0,
      "url": "https://<your-org>.atlassian.net/jira/polaris/projects/.../JPD-1234",
      "owner": "string?",
      "updated": "ISO 8601"
    }
  ]
}
```

## How to query

JPD items live in dedicated discovery projects. Discover them via
JQL like:

```
project IN <discovery-project-keys>
AND statusCategory != Done
ORDER BY priority DESC, updated DESC
```

If `$ARGUMENTS` is set, pass it as a project filter; otherwise the
skill should hit known JPD projects (or write `mcp_error` if it
can't enumerate).

## Output discipline

- `mkdir -p` parent.
- Atomic write.
- Print exactly: `SAVED: data/files/areas/planning/jpd.json`
- Empty / error path writes `{"ideas": [], "mcp_error": "..."}`.
