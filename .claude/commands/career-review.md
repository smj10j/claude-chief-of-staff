# Career Review

Produce a **current-level + next-level readiness review** for a direct report or skip-level report. Every review answers two questions, each fully sourced: *how is this person operating at the level they hold today?* and *how ready are they for the next rung?* Output is a refreshed `career/README.md` (overview) plus a `career/<target-level>-readiness.md` (deep analysis) in the person's folder. If you've written your own self-review, use it as the model for tone and depth.

## Arguments

The argument string is: $ARGUMENTS

Parse as: a person's name (a direct report or skip-level report), optionally followed by a target level (e.g. `alice M2`, `bob L6`, `alice`).
- If **no name** is given, list the people who have a `career/` folder under `data/files/areas/one-on-ones/{direct-reports,skip-level-reports,self}/` and ask which to run (or offer to run several).
- If **no target level** is given, infer the next rung from their current level (from `person.json`, `career/README.md`, or the 1:1 README) and confirm before writing anything.

## Before you start: read the method

This command runs the playbook. Read it first. It owns the process, the sourcing rules, and the pitfalls, so follow it rather than improvising:
- `data/files/areas/career/career-review-playbook.md`: method, inputs, verdict-table format, sourcing discipline, refresh cadence, run log.
- `data/files/areas/career/eng-leveling-framework.md`: your leveling framework, if you keep a local copy. Otherwise use the link to your live framework doc or sheet recorded in `data/files/areas/career/README.md`.
- `data/files/areas/career/leveling-guidelines.md`: your personal leveling heuristics, if present.
- Optional: your own self-review under `data/files/areas/one-on-ones/self/<your-slug>/career/`, as a model of the finished artifact.

## Steps

1. **Locate the person.** Fuzzy-search `data/files/areas/one-on-ones/` (direct-reports, skip-level-reports). Read their `README.md`, existing `career/README.md`, the **last ~5 sessions**, and any `compacted_*.md`. If they have no `career/` folder, scaffold one from the template in the one-on-ones README (Career Folder section) first.

2. **Pull the framework bars** for **both** the current level and the target level, across every competency. Use your leveling framework: the local `eng-leveling-framework.md`, or the live sheet/doc via the Google Workspace MCP if that's where the canonical text lives. Pick the right track (IC vs. manager). If the local copy and the live source disagree, use the live source and note the discrepancy.

3. **Gather evidence via a subagent**, one per person (in parallel when reviewing several). Each subagent reads **only that person's folder** and returns quote-level evidence mapped to each competency, plus current-state facts and growth edges. Include the bar text for both levels in its brief, so evidence lands against the right expectations.

4. **Gather role and org context** once per batch, shared across people. Run a research subagent across whatever sources you have connected (Slack, Glean, Google Docs) for role definitions, your org/team map, and manager or peer signal. Record canonical doc links so the next run can find them.

5. **Write the two docs** into the person's `career/` folder:
   - **`README.md`**: overview. A single-line header with current level · target · team · last updated; a one-paragraph headline; strengths; growth areas (each linking to the matching synthesis entry in the readiness doc); what they own today; next steps as checkboxes; references.
   - **`<target-level>-readiness.md`** (e.g. `m2-readiness.md`, `l6-readiness.md`). Use the structure defined in the playbook: header with the sourcing note, a level map, a **current-level** verdict table + per-competency analysis, a **target-level** verdict table + per-competency analysis, then synthesis and a source index.

6. **Verify links.** Check that every cited session or project file exists (an `ls` loop is enough), and fix broken relative links and heading anchors.

7. **Append to the playbook's run log** (`data/files/areas/career/career-review-playbook.md`): date, who was reviewed, target level.

8. **Offer to commit** (local only). Stage just the touched `career/` files and the run-log line; don't sweep in unrelated working-tree changes.

## Rules

- **Every claim needs a source**: a framework quote, a dated 1:1 session, or a project artifact. Be specific ("manager feedback in the 3/25 1:1", not "leadership feels").
- **The current-level section is never optional.** For someone far from promotion it's the most useful part of the review, so give real, specific feedback against the bar they hold today.
- **Prep-only sessions aren't outcomes.** If a session's `## Raw Notes` is empty, its content is prep-time research, not what was actually discussed. Attribute it that way, and add a header caveat to confirm the highest-stakes claims live before they go into a promotion packet.
- **Proposals aren't facts.** Describe draft reorgs, slated roles, or unannounced scope changes as "proposed" or "emerging", and cite what is actually in effect.
- **Use one level numbering scheme**, the one in your current framework. Flag any older numbering you find in the repo rather than silently mixing schemes.
- **Cite verbal feedback where it lives.** Signal that was only said aloud lives in 1:1 notes; cite those, not a chat tool.
- **Confidential.** This is for your internal use. Never include anyone's phone number, email, or home address in the output.
