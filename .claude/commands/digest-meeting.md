# Digest Meeting

Digest notes from a completed 1:1 or meeting. The person/meeting name will be provided as $ARGUMENTS.

If no name is provided, check today's calendar for recently ended meetings and ask which one to digest.

This command handles both:
- **1:1s** (folders in `data/files/areas/one-on-ones/`)
- **Recurring meetings** (folders in `data/files/areas/meetings/`)

## Steps

### 1. Find the Session File

**For 1:1s:**
- Search `data/files/areas/one-on-ones/` for a folder matching the name
- Read the person's `README.md` for context (shared doc link, relationship type, standing questions)
- Find today's session file in `sessions/`

**For meetings:**
- Search `data/files/areas/meetings/` for a folder matching the name
- Read the meeting's `README.md` for context (shared doc link, standing agenda)
- Find today's session file in `sessions/`

If no session file exists for today, ask if the user wants to create one.

### 2. Gather Meeting Content

Run in parallel:
- **Read raw notes** from the session file (everything under `## Raw Notes`)
- **Read the shared Google Doc** if available via integration (link in README). For large docs, read just the most recent tab/section. **This is often the primary source of meeting content** — participants frequently take live notes in the Google Doc, not in the internal session file.
- **Read any inline notes** the user added directly to the README (sometimes quick notes get dropped there instead of the session file)
- **Check Slack** (if integration available) for any post-meeting feedback, follow-up threads, or action items related to the meeting (search last 2 hours)

### 3. Digest the Session File

**For 1:1s**, follow the digest workflow in `data/files/areas/one-on-ones/README.md` (Phase 2: Post-Session Digest):
1. Replace `## Raw Notes` and `## Prep` with structured `## Session Notes` (organized by topic)
2. Add `### Not Covered` for prep topics that didn't come up
3. Add `## Follow-ups` with checkboxed action items
4. Preserve original prep under `## Prep Context (pre-session)`
5. Update the person's `README.md` — propagate durable changes (role shifts, growth signals, relationship dynamics, shared doc link). Move any inline notes from the README into the session file
6. Propose new action items and task updates for review

**For meetings**, structure the session file as:
1. `## Session Notes` — organized by topic, not chronological
2. `## Key Takeaways & Follow-ups` — checkboxed action items
3. `## OKR Updates` (if applicable)
4. Preserve pre-meeting notes under `## Pre-Meeting Notes (for reference)`
5. Update the meeting's `README.md` if anything durable changed (attendees, cadence, OKR status)
6. Propose new action items and task updates

### 4. Update Tasks

- Search existing tasks for anything related to topics discussed
- Propose updates to existing tasks (new context, status changes, date changes)
- Propose new tasks for action items that came out of the meeting
- **Do not create or update tasks until the user approves**

### 5. Capture Feedback Signals

If the user mentions feedback they received (positive or negative):
- Include it in the session notes
- Update the relevant README (e.g., meeting README, person README)
- If it's career-relevant feedback, note it in the session and consider whether it belongs in `data/files/areas/career/`

## Rules
- Always read both the internal session file AND the shared Google Doc (if available). The Google Doc is often the primary source.
- Always convert timestamps to the user's local timezone.
- Don't repeat context the person already knows.
- If the user provides verbal notes (in the chat message), treat those as raw notes and incorporate them.
- After digesting, offer to create/update tasks for any follow-ups identified.
- No em-dashes in copy/paste sections (Shared Agenda, etc.). Em-dashes are fine in internal prep/context sections.
