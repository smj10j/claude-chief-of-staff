# 1:1 Prep

Prepare for a 1:1 meeting. The person's name will be provided as $ARGUMENTS.

If no name is provided, check today's calendar for upcoming 1:1s and ask which one to prep.

## Steps

### 1. Find the Person
- Search `data/files/areas/one-on-ones/` for a folder matching the name (check direct-reports, peers, manager, skip-level, skip-level-reports, xfn)
- Read their `README.md` for persistent context
- Read their most recent session file in `sessions/`
- If no folder exists, say so and offer to create one

### 2. Find the next 1:1 date

Use the google-workspace MCP (`google_calendar_search_events` or `google_calendar_list_events`) to find the **next upcoming 1:1 meeting** with this person. Search the next 14 days. The session file's date is that meeting's date in the user's local timezone (YYYY-MM-DD).

Fallback hierarchy if google-workspace isn't available or returns nothing:
1. If today's calendar has a 1:1 with them (already-passed or upcoming): use today's date.
2. Otherwise, infer from the cadence of recent session filenames in `sessions/` (e.g., weekly → next same weekday).
3. As a last resort, use today's date.

**Check RSVP status** on the calendar invite. If they haven't accepted, have declined, or are tentative, flag it prominently at the top of the prep (e.g., "[Name] has not accepted this invite — confirm they're available before prepping further"). Also check for any OOO signals from Slack/comms.

### 3. Gather Context
Run in parallel with step 2:
- **Tasks**: Run `bash bin/cos task list --format json` and search for tasks tagged with their team or mentioning their name
- **Signals**: If a Slack/comms integration is available, search for recent messages from or mentioning this person (past week). Look for threads they started, decisions made, issues raised
- **Shared Doc**: If the README has a shared Google Doc link, note it for reference (don't read unless specifically asked — it may be long)
- **Projects**: Check if any active projects in `data/files/projects/INDEX.md` involve this person
- **Recent PRs (B9-CP32)**: If `person.json` has a `github_login`, run `gh search prs --author=<login> --state=all --limit=10`. Capture title + repo + state for each.
- **Open Jira (B9-CP32)**: If the Atlassian MCP is available, run a JQL query for `assignee = "<email>" AND statusCategory != Done ORDER BY priority DESC, updated DESC` (cap to 10). Capture key + title + status + priority.

### 4. Save the session file (idempotent — update if it exists)

Target path: `data/files/areas/one-on-ones/<relationship>/<slug>/sessions/<NEXT-1ON1-DATE>.md`.

If a file already exists at that path, **read it first and merge**:
- Preserve any user-authored content under `## Raw Notes` (the live note-taking section) verbatim.
- Replace the Shared Agenda + prep sections above with the freshly-generated content.
- Keep any user-added sections that fall outside the Shared Agenda + standard prep blocks.

If the file doesn't exist, create it.

The session file MUST start with a `## Shared Agenda` section — a compressed, copy/paste-ready list for the shared Google Doc. Each item should be a question or topic to check in on. Keep it tight, no background context.

Below the shared agenda, include:
- Full prep with context, coaching notes, research
- Topics from the README's "Next Session Topics" section (if any)
- Questions from the README's rotation questions
- Any signals from Slack/tasks that should be discussed
- **Source links are REQUIRED, not optional.** Every external claim must carry a link. Slack threads → permalink. Google Docs/Sheets/Slides → full URL. Jira → ticket URL. Confluence → page URL. GitHub PRs/repos → full URL. Prior session files and project READMEs → relative paths. See `data/files/areas/one-on-ones/README.md` → "Source Links in Prep (REQUIRED)" for the full rule. If a claim has no link, you didn't verify it — go find the source before writing the line.
- **Recent work (B9-CP32)** — when data is available, a section with two sub-bullets:
  - **PRs (last 14d)**: from step 3, formatted as `[repo#num] title — state` with relative updated time.
  - **Open Jira**: from step 3, formatted as `[KEY] title — Status · Priority`.
  Render only the sub-bullets that returned data. Skip the entire section when both are empty.
- A `## Raw Notes` section at the bottom (empty, for live note-taking)

### 5. Print the saved path (last line, exact format)

After saving, print a one-line summary describing what landed (created vs updated, what changed) followed by **exactly one final line** matching this format:

```
SAVED: <relative-path-from-repo-root>
```

Example:
```
Updated existing file; preserved 12 lines of Raw Notes.
SAVED: data/files/areas/one-on-ones/direct-reports/alice/sessions/2026-04-25.md
```

The v2 UI parses this line to know which file to open in the editor; the REPL caller can ignore it. **The `SAVED:` line must be the last line of the response.**

### 6. Offer to Copy (REPL only)
If invoked from the REPL (not the v2 UI), offer to copy the Shared Agenda to clipboard via pbcopy. The v2 UI opens the file directly so this isn't needed there.

## Rules
- Always read the README and last session before generating anything.
- Follow the session workflow defined in `data/files/areas/one-on-ones/README.md`.
- Don't repeat context the person already knows — the shared agenda is for structuring the conversation, not lecturing.
- If the README has "Next Session Topics", always include them and note that they came from a prior session.
- After the meeting, the user will add raw notes. They can ask Claude to digest them separately.
