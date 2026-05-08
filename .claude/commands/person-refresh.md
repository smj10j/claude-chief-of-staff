# Person Refresh

Pull a single person's Slack / email / title metadata via available MCPs and update their `person.json` on disk. The person's slug or name will be provided as `$ARGUMENTS`.

Both the v2 UI's "refresh" button on a profile page and a direct `/person-refresh alice` invocation in the REPL land at the same outcome — the per-person `person.json` updated with fresh data.

## Steps

### 1. Locate the person

- If `$ARGUMENTS` matches a folder name under `data/files/areas/one-on-ones/<relationship>/<slug>`, use that.
- Otherwise treat it as a name and search `data/files/areas/one-on-ones/` for a slug matching it.
- If no folder exists, stop and explain — refresh only works on people with 1:1 folders.

Read the existing `person.json` (if any) for the resolved folder. Anything already set is the field-level baseline you'll merge into.

### 2. Look up via Slack

Use slack-local-mcp:
- Try `slack_search_people` with the person's full name.
- If that doesn't disambiguate, fall back to `slack_users_info` with a known user id (e.g., from a prior person.json's `slack_id`).

From the response (`{ user: { id, profile: { email, title, image_512, image_192, image_original } } }`):
- `slack_id` = `user.id`
- `slack_url` = `https://<workspace>.slack.com/team/<slack_id>` — derive `<workspace>` from any other Slack data you have access to (e.g., the URL the MCP uses for other replies).
- `photo_url` = `user.profile.image_512` (fall back to `image_original` or `image_192`; always pick the largest available)
- `email` = `user.profile.email`
- `title` = `user.profile.title`

### 3. Fall back to Glean for gaps

If Slack didn't return email or title, run a glean people-search for the person to fill those in.

### 3a. External-id fields (B9-CP30)

When available without an extra MCP query, also populate:

- `github_login` — pull from the Slack profile's "GitHub" custom field if present, or look for a stored `github` link on the user. Leave unset if not findable; users edit by hand. Used by Person Profile to render their open PRs (B9-CP31) and by /prep-1on1 to ingest recent work context (B9-CP32).
- `paging_id` — PagerDuty user id (e.g. `PXXXXXX`). Match by email if a PagerDuty MCP is configured, otherwise leave unset; users add the id from their PagerDuty profile URL.

Both fields are optional. Never invent a value — leave the key unset rather than guessing.

### 4. Merge and write

Read the existing `person.json` (or treat as empty if missing). For each field you confirmed, overwrite. For each field you didn't look up or couldn't confirm, leave existing data intact. Don't blank out a hand-edited field by writing `null` over it — omit instead.

Write the result to `data/files/areas/one-on-ones/<relationship>/<slug>/person.json` using the Write tool. Pretty-print with 2-space indent.

### 5. Print a summary

One short paragraph:
- Which fields were updated (e.g., "added photo_url, slack_id; preserved existing title").
- If nothing changed (Slack returned the same data already on disk), say so.
- If the lookup failed (person not in Slack, ambiguous match), explain so the caller knows whether to retry with a different argument.

## Rules

- Do not guess. If a field can't be confirmed, leave it out.
- `photo_url` must be a direct image URL from Slack's CDN (e.g., `https://ca.slack-edge.com/...`), not a profile page URL.
- `slack_id` is the raw Slack user id (e.g., `U01ABCDEF`).
- `github_login` is the bare login (no `@`, no URL).
- `paging_id` is the PagerDuty user id (e.g. `PABCDEF`), not the email.
- This skill is single-person — never batch-update multiple people at once. Use `/org-generate` for that.
