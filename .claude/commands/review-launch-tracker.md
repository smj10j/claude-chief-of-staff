# Review Launch Tracker

Review a launch tracker spreadsheet and flag issues, missing items, and stale data.

## Spreadsheet

Open the tracker via google-workspace MCP (Google Sheets read):
<!-- Replace with your team's launch tracker spreadsheet URL -->
`https://docs.google.com/spreadsheets/d/YOUR_SPREADSHEET_ID/edit`

Read the active year's sheet (currently the current year).

## Review Steps

### 1. Flag items needing approval (run in parallel with step 2)

Scan for rows where:
- **Ready but not approved**: "Ready / Not Ready" says "Ready" but "Launch approval" is blank or doesn't contain "Approved"
- **Upcoming launch date with missing artifacts**: Launch date is within the next 7 days and any of these are blank: PRD, Risk assessment, Comms, Monitoring, Launch/Rollback Plan, Launch approval
- **Stale dates**: Launch date has passed but status doesn't say "Shipped" — likely needs a status update

### 2. Search for missing launches

If a Slack/comms integration is available, search for recent launch activity that may not be on the tracker:
- Search team channels for recent ship posts and launch announcements
- Search project-specific channels for launches touching your domain
- Cross-reference against what's already on the tracker
- Look for phase 2 / expansion launches of items already marked shipped (e.g., one bank partner shipped but another phase missing)

### 3. Present findings

Output a structured review:

#### Items Needing Immediate Attention
Launches that are urgent — approaching dates without approval, missing critical artifacts. Include what's missing and who to follow up with.

#### Stale Items
Rows where the launch date has passed but status wasn't updated to shipped. Recommend updating.

#### Missing Launches
Projects found in Slack that aren't on the tracker. Include: team, project name, DRI, approximate launch date, and what channel/thread the evidence came from.

#### Not Ready (TBD) Summary
Table of items with TBD dates and what artifacts are still missing. Brief — these are informational, not urgent.

### 4. Make edits

After presenting findings and getting confirmation:

**For flagging existing items**: Update the "Launch approval" cell with a note describing what's missing, prefixed with the flag emoji and suffixed with "(flagged MM/DD review)".

**For adding missing launches**: Insert new rows in chronological position among recent items. Fill in all known columns. In the "Launch approval" cell, note that the row was added during review with the date, and flag if governance artifacts need verification.

**For all edits**: Include a note in the affected cell explaining why the change was made, so human reviewers have context.

## Rules
- **People references**: When adding person names to cells, always use RichTextValue with mailto links via `google_workspace_run_script` (Apps Script). Look up emails via people search first. Use ` / ` as separator for multiple people.
- Always read the spreadsheet fresh — don't rely on cached data from earlier in the conversation.
- Convert all dates to a consistent format when presenting findings.
- When in doubt about whether something belongs on the tracker, add it and flag for verification rather than omitting it.
- Offer to draft follow-up messages for urgent items (copy to clipboard via pbcopy).
- Today's date: use the current date for all "flagged" annotations.
