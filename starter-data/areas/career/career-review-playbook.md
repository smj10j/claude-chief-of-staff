# Career Review Playbook

A repeatable method for writing a **current-level + next-level readiness review** for someone you manage (or for yourself). `/career-review` runs this playbook; this file is the source of truth for how a review is built and what makes it trustworthy.

## Why two lenses

Most promotion write-ups only ask "are they ready for the next level?" That leaves anyone who isn't close to promotion with nothing useful. A good review answers both:

1. **Current level:** where are they above, at, or below the bar for the level they already hold?
2. **Next level:** for each competency, how far are they from the target bar, and what would close the gap?

Using the same format for both sections makes the gap visible at a glance and keeps the feedback honest in both directions.

## What a finished review contains

Two files in the person's `career/` folder:

**`career/README.md`: the overview** (aim for one screen or two)
- Header on a single line: current level · target level · team · last updated
- A headline paragraph: the one-sentence read, then two or three sentences of context
- Strengths and growth areas. Each growth area links to the matching part of the readiness doc's synthesis.
- Current landscape: what they own now, who they work with, what's changing
- Next steps as checkboxes, with an owner for each
- References to the readiness doc, the framework, and the key sessions

**`career/<target-level>-readiness.md`: the deep analysis**, in this order:
1. **Header**: who the review covers, the level they hold and the one they're aiming for, who wrote it and when, and a short note on how evidence was sourced (plus the prep-only caveat if it applies; see Sourcing rules).
2. **Level map**: a small table of the current rung → target rung, and the one sentence that best captures what's different about the target level.
3. **Performing at [current level]**: a verdict table, then one section per competency that quotes the current-level bar and lays out the evidence.
4. **[Target level] readiness**: the same format against the target-level bar.
5. **Synthesis**: where they excel; the gaps in priority order, each with a concrete next action; a one-sentence overall read.
6. **Source index**: framework, org/role docs, the 1:1 sessions cited, and any project artifacts.

### Verdict table format

Use the same table shape for both lenses so they can be compared side by side:

| Competency | Verdict | Evidence (linked) |
|---|---|---|
| <competency from your framework> | 🟢 / 🟡 / 🔴 | [1:1 2026-01-15](../sessions/2026-01-15.md), [design doc](../../../../projects/example-project/README.md) |

Legend:
- *Current-level table:* 🟢 above the bar · 🟡 at the bar · 🔴 below the bar for their current level
- *Target-level table:* 🟢 already operating at the target · 🟡 trending toward it · 🔴 clear gap

A reader should be able to scan both tables and see the shape of the person in under a minute.

## Inputs

**In this repo**
- The person's 1:1 folder: `README.md`, `career/README.md`, the last ~5 session files, and any `compacted_*.md` summary
- `person.json`, for title and level if present
- Your leveling framework: `eng-leveling-framework.md` in this folder, or a link to the live source (record the link in this folder's `README.md` so every run uses the same one)
- Your personal heuristics: `leveling-guidelines.md`, if you keep one
- Brag docs, self-reviews, or promotion packets already in their `career/` folder
- Optionally, your own self-review, as a model of tone and depth

**From connected tools (optional)**
- Live framework text via the Google Workspace MCP, if your framework lives in a Sheet or Doc
- Role definitions, team maps, and peer or manager signal via Slack, Glean, or Docs search

## Process

1. **Fix the bar first.** Before reading any evidence, pull the exact framework text for every competency at both the current and the target level, and pick the right track (IC or manager). Everything else is mapped onto this text.
2. **One evidence pass per person.** Hand a subagent the bar text and that person's folder only. Ask for quote-level evidence per competency, current-state facts, and the growth edges it sees. Running one subagent per person keeps the main context small and lets a batch run in parallel.
3. **One research pass per batch.** A single research subagent gathers shared context: role definitions, the current team map, canonical doc links. Reuse it across everyone in the batch.
4. **Write it yourself.** Synthesize the two docs from the returned evidence. Don't let the evidence pass write conclusions.
5. **Check every link.** Confirm each cited file exists and each anchor resolves before you call the review done.
6. **Log the run** below.

## Sourcing rules

- **No unsourced claims.** Each verdict needs a framework quote plus at least one dated artifact: a 1:1 session, a design doc, an incident write-up, a PR, a launch.
- **Prefer dated, first-hand artifacts** over summaries. A session note from the week it happened beats a quarterly recap.
- **Separate prep from outcomes.** A session file with an empty `## Raw Notes` section holds what you *planned* to discuss, not what happened. Label that evidence as such, and add a header caveat to confirm the high-stakes points live before the review feeds a promotion packet.
- **Proposed is not decided.** Draft org changes, pending role changes, and unannounced scope belong in the review as "proposed" or "emerging", with a citation for what's actually in effect today.
- **One numbering scheme.** If older docs use a different level numbering than your current framework, normalize to the current one and note the discrepancy.
- **Cite verbal signal where it was recorded.** Feedback that was only said aloud lives in your 1:1 notes; cite those, not a chat tool.

## Giving real current-level feedback

Even when promotion is a long way off, the current-level section should read like coaching, not a formality:
- Name the one or two competencies where they're strongest, with the evidence that shows it.
- Be specific about anything below the bar for the level they already hold. That's the most important thing in the review, and it's easy to soften.
- Turn each gap into a next step they could start this month, with what "good" would look like.

## Common pitfalls

- **Inflation:** rounding 🟡 up to 🟢 because the person is well liked or the relationship is good. If you can't point to the evidence, it's not 🟢.
- **Recency bias:** letting the last few weeks dominate. Look across the whole review window, and use the compacted summaries for the earlier part.
- **Unsourced claims:** "everyone knows they're great at X." Find the artifact or drop the claim.
- **Scope vs. impact:** a bigger area or more people is not the same as higher-level impact. Judge outcomes against the framework's language, not the size of the remit.
- **Framework drift:** quoting a remembered or paraphrased bar instead of the current text. Always quote the source.
- **Over-reading one data point:** a single great launch or a single rough incident is a data point, not a trend.

## Refresh cadence

- Refresh each review cycle, after a reorg or a framework update, or on request.
- To refresh: re-run the evidence pass on the latest sessions, re-check the framework text and the team map, update both verdict tables and the synthesis, and bump `Last updated`. Git history keeps the earlier version.

## Run log

<!-- One line per run, newest first. Example:
- 2026-01-20: alice (target M2), bob (target L6)
-->
