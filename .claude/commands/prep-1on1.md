# 1:1 Prep

Prepare for a 1:1 meeting. The person's name will be provided as $ARGUMENTS.

If no name is provided, check today's calendar for upcoming 1:1s and ask which one to prep.

## Steps

### 1. Find the Person
- Search `data/files/areas/one-on-ones/` for a folder matching the name (check direct-reports, peers, manager, skip-level, skip-level-reports, xfn)
- Read their `README.md` for persistent context
- Read their most recent session file in `sessions/`
- If no folder exists, say so and offer to create one

### 2. Gather Context
Run in parallel:
- **Tasks**: Run `bash bin/db/task-cli.sh list --format json` and search for tasks tagged with their team or mentioning their name
- **Calendar**: Check today's calendar for the meeting time and any adjacent meetings. **Check the other person's RSVP status** — if they haven't accepted, have declined, or are marked as tentative, flag it prominently at the top of the prep (e.g., "[Name] has not accepted this invite — confirm they're available before prepping further"). Also check for any OOO signals from Slack/comms.
- **Signals**: If a Slack/comms integration is available, search for recent messages from or mentioning this person (past week). Look for threads they started, decisions made, issues raised
- **Shared Doc**: If the README has a shared Google Doc link, note it for reference (don't read unless specifically asked — it may be long)
- **Projects**: Check if any active projects in `data/files/projects/INDEX.md` involve this person

### 3. Generate Session File
Create a new session file at `data/files/areas/one-on-ones/[category]/[person]/sessions/YYYY-MM-DD.md` following the format defined in `data/files/areas/one-on-ones/README.md`.

The session file MUST start with a `## Shared Agenda` section — a compressed, copy/paste-ready list for the shared Google Doc. Each item should be a question or topic to check in on. Keep it tight, no background context.

Below the shared agenda, include:
- Full prep with context, coaching notes, research
- Topics from the README's "Next Session Topics" section (if any)
- Questions from the README's rotation questions
- Any signals from Slack/tasks that should be discussed
- Include links to source materials (Slack threads, Google Docs, Jira tickets, Confluence) inline in the prep. Show your work — most of the time a link is useful. Be thoughtful about when to link and when not to.
- A `## Raw Notes` section at the bottom (empty, for live note-taking)

### 4. Offer to Copy
Offer to copy the Shared Agenda to clipboard via pbcopy for easy pasting into the Google Doc.

## Rules
- Always read the README and last session before generating anything.
- Follow the session workflow defined in `data/files/areas/one-on-ones/README.md`.
- Don't repeat context the person already knows — the shared agenda is for structuring the conversation, not lecturing.
- If the README has "Next Session Topics", always include them and note that they came from a prior session.
- After the meeting, the user will add raw notes. They can ask Claude to digest them separately.
