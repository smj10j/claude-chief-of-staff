# Review Launch Tracker

Review your team's launch tracker spreadsheet, flag issues, enrich missing data, and keep the tracker current as the single source of truth for launch governance.

## Spreadsheet

Open the tracker via google-workspace MCP (Google Sheets read):
`<your-tracker-spreadsheet-url>`

Read the active year's sheet (currently "2026").

## Column Reference

| Col | Header | Type | Notes |
|---|---|---|---|
| A | (Team) | Category | e.g., Team A, Team B, Cross-team |
| B | Project | Name | |
| C | Material (Y/N) | Flag | Drives whether artifacts are required |
| D | DRI | **Person (Slack link)** | Project owner(s). Linked to Slack profiles |
| E | Launch date | Date | Concrete date or TBD |
| F | Ready / Not Ready | Status | |
| G | PRD | **Artifact link** | |
| H | Risk assessment (launch details) | **Artifact link** | |
| I | Comms (#<your-team-channel>) | **Artifact link** | Ship post or launch announcement |
| J | Monitoring | **Artifact link** | Datadog, Hex, Amplitude dashboards |
| K | Launch / Rollback Plan | **Artifact link** | Confluence, Notion, or Google Doc |
| L | DRI for post-launch | **Person (Slack link)** | Linked to Slack profiles |
| M | Success Metric | **Artifact link / text** | Hero metric + guardrails |
| N | Launch approval | Status + notes | Approval status, flags, review history |

**Artifact columns** (G-K, M) should contain hyperlinks to actual documents. **Person columns** (D, L) should contain names linked to Slack profiles.

## Review Steps

### 1. Flag items needing approval

Scan for rows where:
- **Ready but not approved**: "Ready / Not Ready" says "Ready" but "Launch approval" is blank or doesn't contain "Approved"
- **Upcoming launch date with missing artifacts**: Launch date is within the next 7 days and any of these are blank: PRD, Risk assessment, Comms, Monitoring, Launch/Rollback Plan, Launch approval
- **Stale dates**: Launch date has passed but status doesn't say "Shipped" — likely needs a status update

### 2. Enrich missing artifact links

This is a critical step. Many rows have blank artifact columns even when the documents exist — teams create them but don't always link them in the tracker.

**For every row with blank artifact columns (G-K, M)**, search for the documents proactively:

#### Search strategy per column

**PRD (col G)**:
- Glean search: `{project name} PRD` filtered to `app: confluence` or `app: gdrive`
- Also try: `{project name} product requirements`

**Risk assessment / launch details (col H)**:
- Glean search: `{project name} risk assessment` or `{project name} launch details`
- Also try: `{project name} launch readiness`
- Often embedded in the launch plan — if you find a launch plan, check for risk assessment content

**Comms / ship post (col I)**:
- Search Slack (`slack_search_messages`): look for ship posts in `#<your-team-channel>`, `#shipped`, `#<broader-org-channel>`
- Query: `{project name}` in channel `<your-team-channel>`
- Also search team channels: `#<sub-team-1>`, `#<sub-team-2>`, `#<sub-team-3>` for ship/launch announcements
- For shipped items with blank comms: search `{project name} ship` or `{project name} launched` in `#<your-team-channel>` and `#shipped`
- The link should point to the actual ship post Slack thread so others can find the announcement
- **Every shipped item should have a comms link.** If an item is marked shipped but has no link in col I, finding it is a priority

**Monitoring (col J)**:
- Glean search: `{project name} monitoring` or `{project name} dashboard`
- Look inside launch plans (they often contain Datadog, Amplitude, and Hex dashboard links)
- If a launch plan was found for col K, read it — monitoring links are almost always embedded in it
- Common dashboard sources: Datadog (`app.datadoghq.com`), Hex (`<your-org>.hex.tech`), Amplitude (`app.amplitude.com`), Looker (`<your-org>.looker.com`)

**Launch / Rollback Plan (col K)**:
- Glean search: `{project name} launch plan` filtered to `app: confluence`
- Also try: `{project name} rollback plan`, `{project name} launch book`
- Check Notion: many older launch plans live there
- These are the richest documents — they often contain monitoring links, success metrics, tuner flags, and rollback procedures

**Success Metric (col M)**:
- Often defined in the PRD or launch plan. If you found either of those, extract the hero/primary metric
- Glean search: `{project name} success metric` or `{project name} experiment`
- Also check: Slack ship posts (often mention target metrics), experiment readout docs, OKR docs, quarterly planning docs
- For client onboarding launches: eligible-user count may be the success metric (e.g., "~50k eligible users")
- For experiments/A-B tests: extract the hero metric + guardrails (e.g., "Adoption rate (v1 ~25%, v2 target 50-75%). Guardrails: completion, contact rate, revenue")
- For ramp/GA launches: extract the target metric from the launch plan or PRD (e.g., "NPS 60+", "loss rate < 0.75%", "10K+ enrollments")
- Format: brief text describing the metric and target. If the metric has a dashboard link, make the text a hyperlink to that dashboard
- **Every shipped or in-flight item should have a success metric.** If col M is blank, check the PRD, launch plan, ship post, and experiment docs — the metric is almost always stated somewhere

#### How to search effectively

- **Use short, targeted keywords** (Glean is keyword-match). E.g., `"<project> launch plan"` not `"what is the launch and rollback plan for the <project> 2.0 project"`
- **Filter by app** when possible: `app: confluence` for launch plans/TDDs, `app: gdrive` for PRDs/decks
- **Read documents you find** when they contain structured data (launch plans especially). Extract monitoring links, success metrics, tuner flags, and other details that can populate multiple columns at once
- **One launch plan can fill 3-4 columns**: a single Confluence launch plan often contains the risk assessment, monitoring dashboards, success metrics, AND the rollback procedure. When you find one, mine it thoroughly

#### Batch by project

For efficiency, search for all artifacts for a given project at once rather than column by column. A single Glean search for `{project name} launch plan` on Confluence may return the launch plan, TDD, and risk assessment together.

### 3. Fill empty DRI columns (D and L)

If col D (DRI) or col L (DRI for post-launch) is blank for any row:
- Check the PRD or launch plan found in step 2 — these typically list the DRI and launch team
- Search Slack for who is driving the project (look for the person posting updates in the relevant channel)
- Check Glean for document ownership — the person who created the PRD or launch plan is often the DRI
- Look up Slack user IDs via `slack_search_people` so the names can be properly linked

### 4. Update shipped items and stale dates

Scan every row and fix data that has fallen behind:

**Mark shipped items**: If the Launch approval column says "Approved" or the item is clearly shipped (ship post found, confirmed in Slack), but doesn't say "Shipped", update it to include "Shipped" with the date and source (e.g., "Approved; Shipped 4/14 — ship post in #<your-team-channel>").

**Fix stale dates**: If a launch date has passed and the item hasn't shipped, search Slack/Glean for the latest update and correct the date. Use the most recent signal from the DRI or project channel. Format: `~4/25 (slipped from 4/7)` or `TBD (slipped from 4/14, blocked on X)`.

**Update in-flight status**: For items currently ramping (e.g., employee testing, 5% canary), update the Launch approval cell to reflect current rollout state (e.g., "Employee testing started 4/14. 5% ramp TBD.").

### 5. Search for missing launches

Search Glean and Slack for recent launch activity that may not be on the tracker:
- Search `#<your-team-channel>` for recent ship posts and launch announcements
- Search `#<sub-team-1>`, `#<sub-team-2>`, `#<sub-team-3>` for launch discussions
- Search `#<xfn-channel>`, `#<project-channel>` and other project channels for launches touching your team
- Cross-reference against what's already on the tracker
- Look for phase 2 / expansion launches of items already marked shipped (e.g., phase 2 of an item shipped but phase 3 missing)

### 6. Present findings

Output a structured review:

#### Artifact Enrichment
Table of cells that were blank but where documents were found. Show: Row (project name), Column, Document found (title + link), and what to write in the cell. Group by project so the user can see the full picture per launch.

#### DRI Updates
Any DRI or post-launch DRI cells that were blank and can now be filled based on document ownership or Slack activity.

#### Items Needing Immediate Attention
Launches that are urgent — approaching dates without approval, missing critical artifacts that could NOT be found even after searching. Include what's missing and who to follow up with.

#### Stale Items
Rows where the launch date has passed but status wasn't updated to shipped. Recommend updating.

#### Missing Launches
Projects found in Slack that aren't on the tracker. Include: team, project name, DRI, approximate launch date, and what Slack channel/thread the evidence came from.

#### Not Ready (TBD) Summary
Table of items with TBD dates and what artifacts are still missing after search. Brief — these are informational, not urgent.

#### Truly Missing Artifacts
After searching, list any artifact columns that are still blank AND no document could be found. These are the real gaps — documents that likely don't exist yet and need to be created. Flag who should own creating them.

### 7. Make edits

After presenting findings and getting confirmation from the user:

**For enriching artifact links**: Update the blank cell with the document title as display text, hyperlinked to the URL. Use `google_workspace_run_script` with RichTextValue. Style: blue text (`#1155cc`), underlined. Prefer the most authoritative/canonical document when multiple are found. The conditional formatting pass (step 9) will automatically flip enriched cells from red to white — any cell that now has content will get a white background.

**For flagging existing items**: Update the "Launch approval" cell with a note describing what's missing, prefixed with the flag emoji and suffixed with "(flagged MM/DD review)".

**For adding missing launches**: Insert new rows in chronological position among recent items. Fill in all known columns — including artifact links discovered via search. In the "Launch approval" cell, note that the row was added during review with the date, and flag if governance artifacts need verification.

**For updating DRIs**: Use RichTextValue with Slack profile links (see People References rule below). Look up Slack IDs first.

**For all edits**: Include a note in the affected cell explaining why the change was made, so human reviewers have context.

### 8. Sort rows

After all content edits are complete, sort the data rows so the most actionable items are at the top. Use `google_workspace_run_script` to sort in place.

#### Sort order (top to bottom)

1. **Not approved / not shipped** — items that need attention (no "Approved" or "Shipped" in col N). Within this group, sort by launch date ascending (soonest first). TBD dates sort after concrete dates within the group.
2. **Approved but not shipped** — items approved but still in flight (col N contains "Approved" but not "Shipped"). Sort by launch date ascending.
3. **Shipped** — completed items (col N contains "Shipped"). Sort by launch date descending (most recently shipped first).

#### Implementation

Write an Apps Script that:
1. Reads all data rows (row 2 onward)
2. Classifies each row into one of the three groups based on col N content
3. Sorts within each group by launch date (ascending for groups 1-2, descending for group 3). Rows with TBD/blank dates sort to the bottom of their group.
4. Writes the sorted rows back using `range.getRichTextValues()` / `range.setRichTextValues()` to preserve hyperlinks. Plain `getValues()`/`setValues()` destroys links.
5. **Restore dates after sort.** `getRichTextValues()` cannot preserve Date objects (col E) — date cells come back as empty RichText. After writing the sorted RichText, restore all dates in col E by setting values from the original plainValues array. Use `M/d/yyyy` format for dates and plain text for TBD entries.
6. Do NOT modify cell backgrounds during this step — sorting and formatting are separate operations.

### 9. Apply conditional formatting (cell background colors)

After all content edits are complete, apply background colors to visually signal status. Use `google_workspace_run_script` (Apps Script) to set backgrounds efficiently in a single script.

#### Color rules

**Launch approval (col N):**
- **Light green** (`#d9ead3`): Cell contains "Approved" or "Shipped"
- **Light red** (`#f4cccc`): Cell is blank, OR contains a flag, OR item is "Ready" but not approved
- **White** (`#ffffff`): Item is TBD / far-future / not yet relevant

**Artifact columns F-M (Ready status, PRD, Risk, Comms, Monitoring, Launch Plan, Post-launch DRI, Success Metric):**
- **White** (`#ffffff`): Cell has content (condition satisfied), OR item is shipped
- **Light red** (`#f4cccc`): Cell is blank AND the item is NOT shipped. Every blank cell on a non-shipped row is a gap worth seeing — regardless of material status, date, or how far out the launch is. The earlier a gap is visible, the sooner it gets fixed. Do NOT add exceptions for TBD dates, non-material items, or "N/A" values — if it's blank and not shipped, it's red.

#### Implementation

Write a single Apps Script that:
1. Reads all rows
2. For each row, checks the launch date, material flag, and shipped status
3. Applies the color rules above to cols F-N
4. Batch-sets all backgrounds at once using `range.setBackgrounds(colorArray)` for performance

**Critical: Do NOT modify text colors or RichTextValues when applying backgrounds.** Only use `setBackgrounds()` on the range. Setting font colors or rebuilding RichTextValues will destroy existing hyperlinks. Backgrounds and text formatting are independent operations in Google Sheets — changing one should never touch the other.

This ensures the tracker is visually scannable — green = good, red = needs attention, white = not applicable or satisfied.

## Rules

### People References (cols D, L)
When adding or fixing person names in cells, use RichTextValue with **Slack profile links** via `google_workspace_run_script` (Apps Script):
- Look up Slack user IDs via `slack_search_people` first
- Link format: `https://<your-workspace>.slack.com/team/{user_id}`
- Style: **black text** (`#000000`), no underline — the link is invisible but clickable, matching the existing pattern in column D
- Use space or ` / ` as separator for multiple people
- For each name segment, `setLinkUrl(startIdx, endIdx, slackProfileUrl)` with overall text style set to black
- **Index carefully**: endIdx is exclusive in Apps Script. Count characters precisely to avoid "Illegal argument" errors

### Artifact Links (cols G-K, M)
- Style: **blue text** (`#1155cc`), underlined — standard hyperlink appearance
- Display text should be the document title, not the raw URL (unless the URL is the Slack permalink)
- For Slack permalink comms (col I), displaying the URL is acceptable

### General
- Always read the spreadsheet fresh — don't rely on cached data from earlier in the conversation
- Convert all dates to a consistent format when presenting findings
- When in doubt about whether something belongs on the tracker, add it and flag for verification rather than omitting it
- Offer to draft follow-up Slack messages for urgent items (copy to clipboard via pbcopy)
- Today's date: use the current date for all "flagged" annotations
- After making edits, always verify by re-reading a sample of changed cells to confirm links and formatting are intact
- **Row number verification**: Before writing to any cell, read the project name from col B of that row to confirm you're targeting the correct row. The header is row 1; data starts at row 2. Off-by-one errors have caused data to land on the wrong project — always double-check.
- **Never rebuild RichTextValues to change text color.** Use `setBackgrounds()` for background colors and write hyperlinks via `setRichTextValue()` only when adding/changing link content. These are independent operations. Rebuilding RichText to change font color destroys existing hyperlinks.
- **Every text value in artifact columns (G-K) should be a hyperlink.** If writing a PRD name, launch plan title, or dashboard name, always use RichTextValue with the URL. Plain text in artifact columns is a bug — it means the link is missing. When the skill writes any artifact cell, it must include the hyperlink.
