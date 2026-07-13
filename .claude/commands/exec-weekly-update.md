# Exec Weekly Update (example — adapt to your org)

> **This is an example command.** It assumes a common pattern: a recurring,
> company-wide status doc that leadership reads, where you own one
> program/team's sub-section. Rename it, and replace the bracketed
> placeholders (`[YOUR PROGRAM]`, `[DOC TITLE]`, `[DOC URL]`, the section
> names, and the block headings) with your own doc's structure before use.

Draft your **[YOUR PROGRAM]** section of the recurring **[DOC TITLE]**
status doc — a program-level status read by senior leadership. Gather what's
actually moving across your program, draft the update blocks at the right
altitude, and deliver clean text for pasting.

## Audience & altitude

- **Readers are senior leadership.** They want what is *moving* and the big
  program-level items — not every detail.
- **Cut the weeds.** Leave out internal handoffs, ticket-level bugs,
  org/reporting mechanics, and tactical detail. Surface the bets and the launches.
- **Accuracy matters.** A stale or wrong number in front of leadership is
  costly. Verify material/uncertain facts before delivering; flag anything
  unconfirmed instead of guessing.

## The doc

- **Title:** `[DOC TITLE]` — `[DOC URL]`
- **One tab/section per week** (or per period). The newest one is the one to fill.
- **Per-program sections:** the doc is divided into top-level sections, one per
  program/org. **You own the `[YOUR PROGRAM]` sub-section.** Fill only yours —
  the others belong to other leads.
- **Each section has a few standard blocks** (e.g. *Wins / Shipping this week*,
  *Coming up*, *Problems & challenges*). Fill your program's bullets under each.
- If the doc has a shared summary/TL;DR line across sub-teams, don't fill it
  solo — optionally offer a one-line contribution.

## Reading the doc (it may be large)

A long-running shared doc can be too big to read whole. Instead:

1. Read with your Google Workspace integration (`google_docs_read`). For a large
   doc the result may be auto-saved to a tool-results file; **grep that file**
   rather than re-reading.
2. Locate tabs/sections with `grep` (e.g. `grep -n '"text": "[SECTION NAME]"'`).
3. **An already-filled sibling section in the current period is your format
   gold-standard.** Read one to match the period's exact house style and altitude.
4. **Scan the last 2–3 *filled* updates for your program** for live threads and
   continuity. Some periods may be left blank — find the last one actually
   filled (don't assume it's the previous one).

## Steps

1. **Open the current period + scaffold.** Find the newest tab/section, your
   program's block structure, and read a filled sibling section as the format reference.
2. **Establish the baseline.** Find your last *filled* update and scan the prior
   few. List the live threads already being tracked and what was last said about each.
3. **Gather what's moving — be thorough.** Pull current status (with dates +
   metrics) from your repo (recent daily briefings, project INDEX, relevant
   project folders, recent 1:1 and meeting sessions), plus Slack and any
   cross-source search integration for live tickets, roadmap docs, and
   business-review numbers. An Explore subagent is useful for the repo sweep so
   the main thread stays focused.
4. **Verify material facts.** For anything headline-worthy or uncertain (did it
   ship? what's the latest number?), confirm before drafting. Note discrepancies
   between sources and ask which figure to use.
5. **Draft the blocks** (your program only), at leadership altitude — see Format.
   Aim for ~3–4 bullets per block covering the real movers, not an exhaustive list.
6. **Present for approval.** Show the draft. Flag unconfirmed numbers, any shared
   summary line (offer a one-liner), and anything you deliberately left out as
   too in-the-weeds (list it so items can be pulled up).
7. **Deliver to the clipboard only.** On approval, copy the draft to the
   clipboard as **rich text** so bold lead-ins survive the paste — see Delivery.
   **This command never writes to the doc.** You always paste it yourself.

## Format

- **Bold the name/start of each line item**, then an em-dash, then the detail:
  `**Feature X is live** — largest client to date launched 6/8 …`.
- **Match the doc's bullet style:** "Topic — detail", **absolute dates** (`6/8`,
  not "last week"), concrete metrics and gates.
- Follow whatever the sibling sections do about owner names — some docs name
  owners, some don't. Match the house style.

## Delivery (clipboard only)

**This command delivers to the clipboard and stops there — it never edits the
doc.** You paste the bullets under each block yourself.

Bold lead-ins won't survive a plain-text paste into Google Docs (markdown `**`
pastes literally), so copy as **rich text (RTF)** instead:

1. Write the content as HTML — bold the lead phrase (`<b>…</b>`) then em-dash
   then detail, **one `<p>` paragraph per bullet, no bullet characters** (•, -,
   ◦). Google Docs applies its own list formatting when you paste under the
   existing bullets; the RTF only needs to carry the bold and text.
2. Convert and place on the clipboard (macOS, no extra deps):
   ```bash
   textutil -format html -convert rtf -output /tmp/update.rtf /tmp/update.html
   osascript -e 'set the clipboard to (read (POSIX file "/tmp/update.rtf") as «class RTF »)'
   ```
   Verify with `osascript -e 'clipboard info'` — expect a `«class RTF »` entry.
3. Pasting RTF into Google Docs preserves the bold.

- **Fallback:** if rich text isn't viable, copy flat plain text (no bullet chars)
  via `pbcopy` and bold each lead phrase in-doc.
- Offer to copy one block at a time for the cleanest paste.

## Rules

- If you keep a style guide (`data/files/style-guide.md`), consult it for this
  doc's house style.
- **Clipboard only — never write to the doc.** This is a leadership-facing
  shared doc; you always paste it yourself. Deliver via the clipboard and stop there.
- Draft your program's content only; never produce content for other programs'
  or sub-teams' sections.
- Don't fabricate or inflate. Surface unconfirmed numbers as unconfirmed.
