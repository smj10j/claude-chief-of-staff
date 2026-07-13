# Org Generate

Build (or refresh) the org-view file at `data/files/areas/org/org.json` plus per-person metadata in each `data/files/areas/one-on-ones/<rel>/<slug>/person.json`. This is the source of truth for the Chief of Staff UI's People → org tabs.

**Important:** this command writes files directly. Both the v2 UI's "Regenerate" button and a direct `/org-generate` invocation in the REPL land at the same outcome — the org.json + person.json files on disk. The UI just kicks this off and reloads.

## Steps

### 1. Read context

- Read `CLAUDE.md` at the repository root for the user's identity (name, title, team).
- Read the existing `data/files/areas/org/org.json` if it exists. Treat it as the **starting point** — preserve every node unless you have positive evidence it's wrong (person left the company, title changed, reporting line shifted). Fill in gaps. Add new nodes you discover. Do not invent people.
- Walk `data/files/areas/one-on-ones/` to enumerate every relationship folder and the slugs inside (e.g., `direct-reports/alice`, `peers/bob`). Use those exact slugs when referencing those people.
- For each folder slug, read the existing `person.json` if it has one. If a person already has all the meta you'd otherwise look up (`photo_url`, `slack_id`, `slack_url`, `email`, `title`), skip the MCP calls for that person.

### 2. Research (parallel where possible)

Use whichever MCP tools you have available:
- **slack-local-mcp**: who does the user DM? Which channels do they post in? Use `slack_search_people` (by name) or `slack_users_info` (by id) to pull each person's Slack ID + profile photo.
- **glean**: search for "<name> reports to", org-chart docs, team pages, plus people-search for emails.
- **google-workspace**: calendar invite attendees + Google Docs that mention org structure.

Do not guess. If a field can't be confirmed, leave it out. Partial data beats made-up data.

### 3. Produce two views

1. `id="primary"`, `label=<user's primary team / org from CLAUDE.md>` — the user's reporting chain (manager, self, direct reports, skip reports) plus XFN partners who show up in that team's discussions.
2. `id="external"`, `label="External & skip-levels"` — XFN partners outside the primary team, skip-level up relationships, other leaders the user meets with occasionally.

### 4. Write `data/files/areas/org/org.json`

Use the Write tool. The shape:

```json
{
  "views": [
    {
      "id": "primary",
      "label": "<team name>",
      "description": "One-line summary",
      "hierarchy": [
        { "id": "<manager-slug>", "label": "<Manager Name>", "title": "<title>", "slug": "<slug>", "parent": null },
        { "id": "<user-slug>", "label": "<User Name>", "title": "<title>", "slug": "<self-slug>", "is_self": true, "parent": "<manager-slug>" },
        { "id": "<report-slug>", "label": "<Report Name>", "title": "<title>", "slug": "<slug>", "parent": "<user-slug>" }
      ],
      "partners": [
        { "id": "<partner-slug>", "label": "<Partner Name>", "title": "<title>", "slug": "<slug>" }
      ]
    },
    { "id": "external", "label": "External & skip-levels", "description": "...", "hierarchy": [...], "partners": [...] }
  ]
}
```

Field rules:
- `id`: slugify (lowercase, hyphen) — unique across the whole file.
- `parent`: another id in this view's hierarchy, or null for a root.
- `is_self`: true on exactly one node (the user, per CLAUDE.md).
- `slug`: present only when there's a real 1:1 folder. For people without a folder, omit the slug — the UI renders them as "no 1:1". **This includes the `is_self` node:** if the user has a `self/<slug>/` folder under `one-on-ones/` (e.g. `self/<self-slug>`), set its `slug` so their own row links to their profile + career docs. Only omit the self slug if no such folder exists.
- `hidden`: **preserve it.** If an existing node has `"hidden": true`, the user deliberately curated that person out of the visible view — keep the node (with its slug) and the flag. A hidden node stays in the file so the person doesn't show as an orphan, but the UI renders it nowhere. Don't drop it and don't add it on your own.
- `partners`: flat list, no parent field.
- **Do not** include any of: `has_folder`, `relationship`, `rel_path`, `last_session`. Those are computed by the v2 backend on every load.

### 5. Write each `person.json`

For every slug with a 1:1 folder where you confirmed Slack/email/title via MCP, update `data/files/areas/one-on-ones/<relationship>/<slug>/person.json`. Merge with whatever's there (read first, preserve fields you didn't look up):

```json
{
  "title": "<role title from Slack profile or Glean>",
  "email": "<email from Slack profile or Glean>",
  "photo_url": "<Slack profile.image_512 or fallback to image_original / image_192>",
  "slack_url": "https://<workspace>.slack.com/team/<slack_id>",
  "slack_id": "<U01ABCDEF>"
}
```

Slack response shape (extract these exactly):
- `slack_id` = `user.id`
- `photo_url` = `user.profile.image_512` (fall back to `image_original` or `image_192`; always pick the largest available)
- `email` = `user.profile.email`
- `title` = `user.profile.title`

If Slack doesn't have email or title, fall back to glean people-search for those.

**Field-level merge rule**: only overwrite a field if you have new data. If you didn't look up someone (because their existing `person.json` was already complete), don't touch the file. If a field is missing from your lookup, omit it from the write — don't blank out an existing value.

### 6. Print a summary

After all writes finish, print a short markdown summary:
- N people in the org file (M with folders, K without)
- N person.json files updated, K skipped (already complete)
- Any people you couldn't confirm (left out of the org file)

Don't print the JSON contents — they're already on disk.

## Rules

- Take your time. Call MCPs aggressively. A thorough run is expected to take 1-3 minutes.
- Hand-edits in existing org.json or person.json files survive: the merge preserves anything Slack/Glean didn't return.
- If you can't read CLAUDE.md or the project structure, stop and explain — don't generate a half-broken file.
