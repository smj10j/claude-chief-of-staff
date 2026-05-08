---
allowed-tools: mcp__slack-local-mcp__slack_read_conversation, mcp__slack-local-mcp__slack_search_messages, mcp__slack-local-mcp__slack_list_conversations, mcp__slack-local-mcp__slack_users_info, Read, Write, Bash(mkdir:*)
description: Snapshot active incidents from your incident-tracking Slack channel
---

# /ops-incidents

> **ORG-SPECIFIC.** This skill assumes a Slack channel is the source
> of truth for incidents (declared, escalated, and resolved there).
> If your org uses Datadog Incidents, PagerDuty, FireHydrant, or
> another incident-management tool, swap out the data-fetch logic
> below — the snapshot output shape is portable. When the plugin
> runtime lands, this skill is a candidate to move into an org-
> specific plugin so the core can ship a portable default.

Fetch the most recent incidents declared in your incidents channel and
write them to a snapshot JSON file the v2 app reads. Output shape
matches what the Ops → Incidents tab renders directly.

## What to write

Path: `data/files/areas/ops/incidents.json`

Shape:

```json
{
  "fetched_at": "2026-04-25T17:30:00Z",
  "source": "slack:#incidents",
  "incidents": [
    {
      "id": "<slack thread ts>",
      "title": "string",
      "severity": "SEV-1" | "SEV-2" | "SEV-3" | "SEV-4" | "SEV-5",
      "state": "active" | "stable" | "resolved",
      "created_at": "ISO 8601",
      "last_updated_at": "ISO 8601",
      "url": "https://<your-workspace>.slack.com/archives/<C…>/p<thread-ts>",
      "commander": "string?",
      "commander_id": "string?",
      "team": "string?",
      "summary": "string?",
      "tags": ["string"],
      "relevance": "mine" | "adjacent" | "unrelated"
    }
  ]
}
```

## How to query

1. Resolve the channel id for your incidents channel (e.g.,
   `#incidents`) via `slack_list_conversations` (filter
   `channel_types: public_channel`, match name exactly). Bail to
   `incidents: []` + `mcp_error: "no #incidents channel"` if none
   resolves.
2. Read the last ~50 top-level messages with
   `slack_read_conversation`. Most orgs follow the convention that
   each incident is a top-level post with a thread for ongoing
   updates.
3. For each top-level post, also fetch the thread (pass the
   message's `ts` back into `slack_read_conversation` as
   `thread_ts`, limit ~10) so you can read the latest update and
   resolve the commander.
4. For each top-level post, parse:
   - **severity** — most posts start with or contain a `SEV-1`/`SEV-2`/
     etc. token. Default to `SEV-3` if missing but the message clearly
     describes an incident.
   - **state** — read the latest reactions or thread tail for
     "resolved", "stable", "active" / "ongoing" cues. Posts with no
     update in 24h+ that haven't been marked resolved → `stable`.
     Mirror the channel's existing convention rather than inventing
     one.
   - **title** — the first line of the post, trimmed.
   - **url** — Slack's deep-link format
     `https://<workspace>.slack.com/archives/<channel_id>/p<ts>`
     (remove the `.` from the ts).
   - **created_at** — the top-level post's ts.
   - **last_updated_at** — ts of the most recent thread reply, or
     fall back to `created_at` if no replies. This is what the UI
     surfaces next to "opened" so the user can tell which incidents
     are actively churning vs. quiet.
   - **summary** — a single sentence describing the *current* state
     of the incident. Prefer the most recent thread reply that
     looks like a status update ("rolled back", "investigating",
     "mitigated, monitoring", "RCA in progress"). Fall back to a
     compressed restate of the top-level post body if there are no
     useful replies. Trim hard — one line, no Slack formatting,
     no bullet glyphs. `null` if the channel offers nothing usable.
   - **commander** — resolved display name of the incident
     commander. The post or first thread reply usually says
     `commander: <@U…>`. When you see a Slack user mention,
     resolve it via `slack_users_info` and write the
     human-readable name (prefer `real_name`, fall back to
     `display_name`, then `name`). Cache lookups within the
     run — the same commander recurs across many incidents.
   - **commander_id** — the raw `U…` Slack user id, kept alongside
     the resolved name so a future read can re-resolve if the
     directory changes. `null` if no commander is declared.
   - **team** — the team or service called out in the post. `null` if
     unclear.
5. **Tag each incident with relevance to the current user.** Read
   `CLAUDE.md` at the repo root for the user's role, teams, direct
   reports, and key XFN partners. Then for each incident:
   - **`relevance: "mine"`** — the incident directly involves a
     team, service, or person the user owns or works with daily.
     Anything mentioning their team(s), services they own, or any
     of their direct reports / team members as commander or in the
     body. SEV-anything that touches a service their team owns or
     depends on directly.
   - **`relevance: "adjacent"`** — the incident touches the user's
     broader org or upstream/downstream surface — sister teams under
     the same VP, platform services their team consumes, XFN
     partners they work with regularly.
   - **`relevance: "unrelated"`** — neither of the above.
   When in doubt, lean toward `adjacent` rather than `unrelated` —
   a manager would rather see a borderline-relevant row than miss
   one. Never guess `mine` — it must be defensible from CLAUDE.md.
6. **Tags** — short human-readable chips that explain the
   classification. 1–3 tags per incident. Examples: `["<your-team>"]`,
   `["<your-team>", "<sub-team>"]`, `["<broader-org>"]`,
   `["@alice"]` (when a direct report is the commander),
   `["platform"]`. Keep them lowercase, hyphenated, and short
   enough to fit in a chip. Empty array if nothing meaningful
   applies — don't pad.
7. Cap to 25 incidents, sorted by `created_at` desc. Skip messages
   that are clearly meta (announcements, "post-mortem published"
   pointers, new-channel-welcome banners).

## Output discipline

- Ensure the parent directory exists (`mkdir -p`).
- Write the JSON file atomically (temp + rename when possible).
- Print exactly one line at the end:
  `SAVED: data/files/areas/ops/incidents.json`
- Do NOT print any other commentary. The Rust side parses the SAVED
  marker to confirm the run.

## Error handling

If the Slack MCP isn't installed or returns an auth error, still
write a valid file with `incidents: []` and a top-level `mcp_error`
field — the Ops surface picks it up and renders an actionable hint:

```json
{ "fetched_at": "...", "source": "slack:#incidents", "incidents": [], "mcp_error": "Slack MCP not registered" }
```

## Adapting to other incident sources

The "Slack is the incident source of truth" assumption is one
common pattern, but not universal. To adapt this skill:

- **Datadog Incidents:** swap the channel-read logic for
  `mcp__datadog-mcp__list_incidents` (or equivalent). Map
  Datadog's severity/state fields to the shapes above.
- **PagerDuty:** use the PagerDuty MCP if available, or the API
  via `gh`-style helper. Map `urgency` → `severity`, `status` →
  `state`.
- **FireHydrant / incident.io / custom tool:** same idea — keep
  the output shape (`data/files/areas/ops/incidents.json`) so the
  v2 Ops → Incidents tab keeps working without changes.
