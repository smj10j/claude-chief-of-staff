# Decision Log

Build a **decision log** for a project or program — a single shared place that answers "what did we decide, and what's still open?" for a body of work whose context has scattered across Slack threads, docs, and a program plan. Synthesizes local project docs, the authoritative program sheet/PRDs, and full Slack channel sweeps into one scannable reference, one table per area, every row one click from its source.

A decision log gets adopted when it is ruthlessly a *decision* log and not a status tracker. Front-load the constraints below so the quality doesn't have to be rediscovered through iteration.

Usage: `/decision-log [project folder id or topic]` (e.g. `/decision-log <project-id>`).

## What belongs in a decision log — the litmus test

Keep a row only if it states one of:

1. **A decision made** — "Refunds go back to the original payment method only (legal review)."
2. **A settled fact about how the thing works** — "Exports run nightly from the read replica; the primary database is never queried."
3. **An open question that still needs a *decision*** — "Whether the beta includes enterprise accounts is undecided."

If a row doesn't state a decision or a fact, it doesn't belong. **Cut** workstream line items, build tasks, schedule/status tracking, pure confirmation/validation tasks, and owner tracking — those live in the program plan / tracker. A row like "Update the rate limiter for partner traffic" is a workstream item, not a decision; either reframe it into the *decision* it encodes ("partner traffic gets its own rate-limit bucket") or drop it.

This is the single most important rule. It's the difference between a decision log people adopt and "another status tracker." When in doubt, ask: is this something someone *decided*, a fact about *how it works*, or a question that needs *a call*? If none of the three, it's out.

**The sister-doc boundary.** State it at the top of the doc: what belongs here vs. what lives in the program plan / workstream tracker. That clean division of labor is what lets the decision log stay decisions-only and gives build tasks a legitimate home elsewhere. Link the sister doc.

## Information seeding — the order

1. **Probe connectors first.** Run `bash bin/cos connectors` (or `ToolSearch` for the specific tool you need) — don't trust any MCP source until it reports connected. If a source is genuinely unavailable, say so in the doc's Sources line rather than silently omitting it.
2. **Read every local project doc end-to-end** before touching external sources. Treat them as the baseline and **note their dates** — you'll sweep Slack for anything decided or reversed since. Anchor scope from the project folder + `data/files/projects/INDEX.md` entry.
3. **Pull the authoritative external sources** — the program-plan spreadsheet (e.g. via the Google Workspace MCP's sheet read; large sheets may spill to a temp file — grep it) and the PRD(s). These frame the decisions.
4. **Fan out one read-only Slack sub-agent per channel**, in parallel, plus your own Slack search passes. Hand each agent the **baseline facts as of [date]** and this extraction spec — capture, for every item:
   - What was decided (or the open question) — one crisp sentence.
   - The topic / area it belongs to.
   - Owner / who decided (for your notes; it won't appear as a column — see Structure).
   - Date, **converted to your local timezone** (state the timezone once in the doc).
   - Status: DECIDED or OPEN.
   - A **Slack permalink** (or channel + approximate timestamp + author) to find it again.
   - A **"what changed since [baseline date]"** section at the top of the return.
   - Instruction: **read-only, do not edit anything.** Return grouped by topic area, DECIDED vs OPEN split.
5. Open key threads in full (read the conversation, not just the search hit) for context around a message — don't rely on the search snippet alone.

**Slack search gotcha:** some Slack search tools are strict-AND on multi-word queries (boolean OR returns 0). Run **many short single-term or short-phrase passes** to cover the ground, not one long query. Sweep further back in the channel that holds the eng rationale (e.g. ~10 weeks back there vs. ~4 for the others).

## Reconciling conflicts — surface, don't adjudicate

The doc earns trust by handling drift honestly:

- **Renamed / re-decided / reversed items** get pinned in **Points of confusion** (see Structure). Example: "Option A" = "the sweep" = "the batched transfer" turned out to be the same design — say so once, plainly.
- **Superseded decisions** stay in the doc marked ♻︎ (so older docs still make sense), pointing at what replaced them.
- **When two authoritative sources genuinely disagree, flag the conflict — don't pick a side.** Give the row a mixed status and a "still to reconcile" note (e.g. the PRD says a feature is out of the beta, the channel says it's in → the row surfaces both). Picking a side a reader can disprove at the source destroys trust faster than an honest "still to reconcile."
- **Flag provenance** for any fact not sourced from the primary channels. Put it in a **Caveats** blockquote near the top.
- **Escalate, don't assume.** If a source thread defers the call ("let's wait for confirmation from <decision-maker>"), mark it OPEN/🟡 and ask the user to adjudicate — never write a deferred call as settled.

## Structure

Order — fast facts → confusion hotspots → detail → reference:

1. **Scope line** — the exact slice in one sentence ("the platform slice of the launch, plus the program facts that frame it").
2. **What belongs here / what doesn't** — the litmus test + the sister-doc boundary, with a link to the tracker/program plan.
3. **Last updated** — `YYYY-MM-DD (<your name>)` + the anchor dates (beta / GA / launch).
4. **How to use** — "each area is one table. Skim Status for settled vs. open, and Source to verify. Start with Points of confusion."
5. **Status legend** — `✅ Decided · 🟡 Open (a decision is still needed) · ⏸ Deferred (GA / post-beta) · ♻︎ Superseded`. Compound states are fine: "✅ eng · 🟡 legal."
6. **Sources** line — every input swept (program plan, PRDs, local docs, which channels + through what date; note the timezone dates are in).
7. **Caveats** blockquote — anything not directly sourced (see Reconciling conflicts).
8. **At a glance** — a Fact / Value table of the 7–8 headline facts (dates, cohort, partners, mechanism, MVP scope).
9. **Points of confusion** — the handful of topics that kept swirling, each with a plain "current source of truth." Intro line: "These have caused the most confusion and back-and-forth. Current source of truth:". Neutral — see Voice.
10. **One table per area**, numbered. Columns: **`Decision / fact · Detail · Status · Source`**. One table per "where would I look for X?" area — a large program can easily have a dozen (e.g. program/launch, core mechanism, eligibility, customer experience, agreements/legal, reporting, data, platform).
11. **Source documents** — program docs, this-folder docs, and the channels (with IDs), at the end.

**No Owner column, and no status-progress language** ("in build," "at risk," "designs blocking eng"). Owners and progress tip the doc back into a program tracker. What remains per row: the statement, the decided/open flag, and a verifiable link. Every row keeps all its cells — an empty cell still occupies a column so the table formatting holds.

Add a **⭐ README pointer** in the project's `README.md` ("the consolidated decision log — start here for 'what did we decide?'") for discoverability.

## Voice

See `data/files/style-guide.md` → Document Style → "Decision Logs & Shared-Reference Docs" for any preferences you've recorded. In short:

- **Human cadence, not juxtaposition.** Write "The launch date." and state the fact. Don't manufacture contradictions ("The launch date — not one number", "one design, several names"). Precision, not juxtaposition.
- **Bold labels only.** Never five bold spans in a paragraph — bold loses meaning. Table cells are unbolded; the header row and Status column carry the structure.
- **Decided-vs-open is carried by the status glyph, not by hedging prose.** State each decision as a flat fact; the ✅/🟡 tells the reader its status.
- **Don't talk down about "re-litigating."** The framing that a topic keeps getting re-argued is the user's internal seed for you — not for the reader. Say a topic "has caused confusion and back-and-forth, here's the source of truth"; don't editorialize about people re-opening it.
- **Detail is calibrated to verify-at-source:** enough that the doc is trustworthy, little enough to stay scannable — and always one click from the deciding thread.

## Delivery

1. **Write the markdown into the project folder** (`decision-log.md`) and add the README ⭐ pointer.
2. **Do an accuracy pass** — re-check the doc against all sources after the content settles. Confirm no unnecessary duplication and that the section breakdown still makes each fact easy to find.
3. **Optionally publish to a Google Doc** via `/publish-to-gdoc`. Before pushing: regenerate the payload and assert every table has a uniform column count; confirm internal anchor links resolve; confirm emoji/color/status glyphs render consistently. (`bin/md-to-gdoc-payload.js` preserves empty cells and resolves internal `#anchor` links to heading bookmarks in paragraphs — anchors inside table cells are left as plain text; see `google-docs-style-guide.md`.) For a **single-row update to a live Doc**, append just that row with an idempotency guard (check it isn't already present) rather than re-rendering the whole doc.
4. **Share message** — when the user posts the log to a channel, draft it in their voice (see `data/files/style-guide.md`; offer `pbcopy`). A pattern that works:
   - Credit who flagged the need — "X and Y flagged there were discussions that kept happening as context got spread across Slack."
   - State the action plainly — "I consolidated a decision log for easy reference."
   - Note it was human-validated — "Z and I ran through it together this morning."
   - Soft CTA to adopt — "please do a pass and use this as a reference going forward."
   - Link the doc with a descriptive title.

## The reusable checklist

- [ ] Connectors probed; local docs read end-to-end with dates noted.
- [ ] Program sheet + PRD(s) pulled; parallel read-only per-channel Slack sweeps with the extraction spec + "what changed since [baseline]."
- [ ] Every row passes the litmus test (decision / settled fact / open question needing a decision). No workstream, schedule, or owner rows.
- [ ] Conflicts surfaced (not adjudicated); superseded/reversed items marked; provenance flagged in Caveats; deferred calls escalated to the user.
- [ ] Structure: scope → belongs/doesn't → how-to-use → legend → At a glance → Points of confusion → one table per area (`Decision / fact · Detail · Status · Source`) → Source documents.
- [ ] Voice: human cadence, bold labels only, status glyph carries decided/open, neutral confusion framing.
- [ ] Every row one click from its source; tables have uniform column counts; README ⭐ pointer added.
- [ ] Optional: published to gdoc with anchor links + glyphs verified; share message drafted in the user's voice.
