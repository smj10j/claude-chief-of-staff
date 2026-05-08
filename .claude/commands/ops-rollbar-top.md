---
allowed-tools: mcp__plugin_rollbar_rollbar__list-projects, mcp__plugin_rollbar_rollbar__get-top-items, mcp__plugin_rollbar_rollbar__list-items, Read, Write, Bash(mkdir:*)
description: Snapshot top Rollbar items for the Ops Health tab (PRD-108)
---

# /ops-rollbar-top

Fetch the top error items across the user's Rollbar projects and
write a snapshot the v2 app can read.

## What to write

Path: `data/files/areas/ops/rollbar-top.json`

Shape:

```json
{
  "fetched_at": "2026-04-25T17:30:00Z",
  "items": [
    {
      "id": "string",
      "title": "string",
      "level": "error" | "warning" | "critical",
      "occurrences": 123,
      "project": "string",
      "url": "https://rollbar.com/...",
      "first_seen": "ISO 8601",
      "last_seen": "ISO 8601",
      "status": "active" | "resolved" | "muted"
    }
  ]
}
```

## How to query

1. List Rollbar projects (`list-projects`).
2. For each project, call `get-top-items` for the last 7 days. If
   that's not available, use `list-items` filtered to `status=active`
   and sorted by `total_occurrences desc`. Cap to 5 per project.
3. Merge across projects, sort by `occurrences` desc, cap to 20
   total.

## Output discipline

- Ensure the parent directory exists (`mkdir -p`).
- Atomic write of the JSON file.
- Print exactly one line at the end:
  `SAVED: data/files/areas/ops/rollbar-top.json`

If the Rollbar MCP is unavailable, write a valid empty file with an
`mcp_error` field — same convention as `/ops-incidents`.
