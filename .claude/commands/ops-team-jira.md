---
allowed-tools: mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql, Read, Write, Bash(mkdir:*)
description: Snapshot Jira issues assigned across the user's team (PRD-109 §5 / B9-CP16)
---

# /ops-team-jira

Snapshot the Jira issues assigned to the user's *team* (not just
themselves) that aren't Done. Powers the Work → Jira → Team
sub-tab.

## What to write

Path: `data/files/areas/work/team-jira.json`

Same shape as `my-jira.json` (B8-CP22) so the UI can reuse the
JiraTab renderer.

## How to query

1. Read the team scope from `data/files/areas/ops/team.txt` if it
   exists, else `$ARGUMENTS`, else default to `<your-team>`.
2. JQL:
   ```
   "Team[Team]" = "<team>"
   AND statusCategory != Done
   ORDER BY priority DESC, updated DESC
   ```
3. Cap to 100 results. Same fields as the my-jira snapshot.

## Output discipline

- `mkdir -p data/files/areas/work/`
- Atomic write.
- Print exactly: `SAVED: data/files/areas/work/team-jira.json`
- Empty / error path writes `{"issues": [], "mcp_error": "..."}`.
