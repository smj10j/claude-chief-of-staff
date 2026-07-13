# 1:1s

## Folder Structure

Organized by relationship type. Populated during `/init`.

```
one-on-ones/
  self/              -- your own "You" page (self/<your-slug>/)
  direct-reports/    -- people who report to you
  manager/           -- your manager
  peers/             -- peers you meet with regularly
  skip-level/        -- leaders above your manager (strategic relationships)
  skip-level-reports/ -- your reports' reports (skip-level 1:1s)
  xfn/               -- cross-functional partners
```

Direct reports, skip-level reports, and your own `self/` folder also get a
`career/` subfolder for career-development docs (see [Career Folder](#career-folder)).

## How I Run 1:1s

### General Principles
- Come prepared with context, not just questions
- Listen more than talk
- Follow up on things from last time

### By Relationship Type

**Direct Reports**
- Their meeting, their agenda first
- Coach, don't solve — ask questions that sharpen their thinking
- Track growth areas and career goals across sessions
- Surface cross-team patterns they might not see
- Celebrate wins, be direct about gaps

**Manager**
- Come with updates organized by: what's going well, what needs help, what decisions I need
- Proactively share what teams are doing — don't make them dig
- Use this time for career growth and strategy
- Ask for feedback regularly

**Peers**
- Strategic alignment — are we pulling in the same direction?
- Share context from respective teams
- Brainstorm together on shared initiatives

**Skip-Level Reports**
- Their agenda first — what do they want from this time?
- What's their experience on the team? What's working, what's not?
- Career growth — where do they want to go?
- Surface things their manager might not be passing up
- Be careful not to go around their manager — if something needs fixing, bring it back to the EM

**Skip-Level / Strategic**
- Relationship building first, agenda second
- Show value — share insights that are useful to them
- Learn what they care about and find ways to contribute
- Lightweight, high-trust

**XFN Partners**
- Understand their priorities and blockers
- Ask: "What could my team do better for you?"
- Proactively help unblock things before they escalate
- Build trust by following through

## Per-Person Notes

### Structure
Each person's folder has these layers:

**README.md** — Persistent context (updated over time, not overwritten per session)
- Role, team, org context
- Working style and interaction patterns
- Key relationships they navigate
- What's generally top of mind for them
- Growth/career context (for direct reports — the full plan lives in [`career/`](#career-folder))
- Standing questions to keep in rotation
- Link to shared Google Doc (used in post-session digest)

**sessions/** — Temporal check-in notes (one file per 1:1)
- Named by date: `2026-03-10.md`, `2026-03-17.md`, etc.
- What we discussed, action items, follow-ups, observations
- **Compaction:** After 3 newer sessions exist, older sessions are archived to `sessions/archive/` and their compact summaries consolidated into a single `sessions/compacted_STARTDATE_to_ENDDATE.md` file. During prep, read the last 3 full sessions; scan the compacted file only for longer-term context threads.

**career/** — Career-development docs (direct reports + skip-level reports; your own docs live under `self/<your-slug>/career/`)
- A `README.md` overview (the development plan) plus any number of extra docs — a promotion packet, a leveling assessment, etc. Shaped like a project folder.
- Surfaced in the app's per-person **Career** section (People → open the person → Career).
- Peers, manager, skip-level, XFN, and alumni folders don't get one by default (the Career section shows an empty "start one" state).

---

## Career Folder

Direct reports and skip-level reports get a `career/` folder scaffolded when
their 1:1 folder is created (see `/init` and `/prep-1on1`). It starts with a
single `README.md` from the standard template below, pre-filled with whatever
is known (level from `person.json`, team, goal) and deepened over time from
1:1s. Additional docs (e.g. a promotion packet) can be dropped alongside it and
appear in the person's Career section automatically.

**Template (`career/README.md`):**

Keep the header meta on a **single line** — two adjacent bold lines get
mangled when a doc is opened + auto-saved in the v2 Tiptap editor.

```markdown
# Career Development: [Name]

**Current level:** ... · **Goal:** ... · **Team:** ... (reports to ...) · **Started:** [date] · **Last updated:** [date]

## Summary
## Strengths
## Growth Areas
  ### N. [Area]
  **Gap:** / **Actions:** / **How you coach this:**
## Current Landscape
## Your Commitments
## Check-in Cadence
```

Shared leveling references (framework, guidelines) stay in
[`../career/`](../career/README.md); only per-person docs live in the person's
folder.

---

## Session Workflow

### Phase 1: Pre-Session Prep

**Trigger:** User asks to prep for a 1:1, or it's part of a daily/weekly planning pass.

**Steps:**
1. Read the person's `README.md` + most recent session file. Note open action items and follow-ups
2. If a Slack/comms integration is available, search for recent context involving that person (since last 1:1 or last 2 weeks)
3. Run targeted searches based on README topics and open action items
4. Cross-reference the task database (`bash bin/db/task-cli.sh list`) and project docs for anything related to this person
5. Contextualize by relationship type (see "How I Run 1:1s" above)
6. Update README if new context changes what's top of mind
7. Create the session file using the template below
8. Convert all timestamps to the user's local timezone

**Session file template:**

```markdown
# 1:1 with [Name] — YYYY-MM-DD

---

## Shared Agenda
- [Compressed, copy/paste-ready items for the shared Google Doc]

---

## Raw Notes
<!-- Fill in during/after the meeting. -->
<!-- "- (nothing notable)" = topic came up, no update. -->
<!-- Omit a topic entirely = it didn't come up. -->



---

## Prep

### [Topic 1]
- Context, questions to ask, coaching framing

### [Topic 2]
...

---

## Context to Have Ready
- [Relevant background items]
```

### Phase 2: Post-Session Digest

**Trigger:** User says they've filled in notes (e.g., "digest my notes", "process the 1:1", "done with notes").

**Steps (in order):**

1. **Read raw notes** from the session file (everything under `## Raw Notes`)
2. **Read the shared Google Doc** if available via integration (link in person's README) — capture agenda items the other person added, outcomes written live, anything not in raw notes. **Always read the shared Google Doc/collaborative notes during digest** — the other person often takes live notes there that don't appear in the session file's Raw Notes section
3. **Restructure the session file:**
   - Keep `## Shared Agenda` at the top unchanged
   - Replace `## Raw Notes` and `## Prep` with structured `## Session Notes` (organized by topic, not by order taken)
   - Add `### Not Covered` for prep topics that didn't come up
   - Add `## Follow-ups` with checkboxed action items
   - Preserve original prep under `## Prep Context (pre-session)` for reference
4. **Update the person's README** — propagate durable changes (role shifts, personnel, growth signals, relationship dynamics). Update "as of" dates
5. **Update tasks** — augment existing tasks with new context via the task CLI, update status/dates if discussed
6. **Propose new action items** — list suggested new tasks, task updates, and potential new projects for review. **Do not create until approved**

### Source Links in Prep

Include links to source materials (Slack threads, Google Drive files, Jira tickets, Confluence articles) in session prep when appropriate. Showing your work makes prep more useful — the user can click through to see the full context. Be thoughtful about when to link:

- **Link when:** referencing a specific Slack discussion/decision, a shared document, a Jira ticket, or a Confluence page that the user might want to read
- **Don't link when:** the reference is obvious, the user already knows the URL, or the link wouldn't add any value
- Most of the time, linking is useful. Err on the side of including links.

### Conventions

| Situation | What to write in Raw Notes |
|---|---|
| Topic came up, no notable update | `- (nothing notable)` |
| Topic didn't come up | Omit it entirely |
| New topic not in prep | Add freely under any header |
| Feedback on someone's manager (skip-levels) | Use `### On [Manager Name]` header |

### Formatting Rules
- **No em-dashes in copy/paste sections.** Use regular dashes/hyphens (`-`) in the Shared Agenda and any other section that will be copied into Google Docs or Slack. Em-dashes (`—`) don't copy/paste cleanly. Em-dashes are fine in Prep, Context, and other internal sections.
