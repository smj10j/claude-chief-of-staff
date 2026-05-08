---
allowed-tools: mcp__datadog-mcp__search_datadog_monitors, Read, Write, Bash(mkdir:*)
description: Snapshot failing Datadog monitors for the Ops Health tab (PRD-108)
---

# /ops-datadog-monitors

Fetch active Datadog monitors that are *not* in `OK` state and write
a snapshot the v2 app can read.

## What to write

Path: `data/files/areas/ops/datadog-monitors.json`

Shape:

```json
{
  "fetched_at": "2026-04-25T17:30:00Z",
  "monitors": [
    {
      "id": 12345,
      "name": "string",
      "state": "Alert" | "Warn" | "No Data",
      "type": "metric alert" | "log alert" | "service check" | "...",
      "tags": ["service:foo", "team:<your-team>"],
      "url": "https://app.datadoghq.com/monitors/12345",
      "modified": "ISO 8601",
      "message": "string?"
    }
  ]
}
```

## How to query

1. Use `mcp__datadog-mcp__search_datadog_monitors` with a state
   filter excluding `OK`. Sort by most recently triggered.
2. Cap to 30 monitors.

## Output discipline

- `mkdir -p` the parent.
- Atomic write.
- Print one line:
  `SAVED: data/files/areas/ops/datadog-monitors.json`

Empty / error path writes valid JSON with `monitors: []` and an
optional `mcp_error` field.
