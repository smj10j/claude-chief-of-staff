# Initialize Chief of Staff

Self-configuring onboarding. Minimize questions — discover as much as possible from integrations, then confirm.

## Steps

### 1. Integrations Check

Before asking anything, detect what MCP tools are available. Try calling each in order and note which succeed:

1. **Google Workspace** (highest priority) — try `google_calendar_list_events` for today. If it works, calendar discovery is available.
2. **Glean** — try a simple `search` query (e.g., the user's name). If it works, Slack/doc discovery is available.
3. **Atlassian** — try `getVisibleJiraProjects`. If it works, Jira is available.
4. **Others** — check for Slack MCP, GitHub MCP, Datadog, Rollbar, etc. by attempting a lightweight call.

Report what's available:
> "I found Google Workspace and Glean connected. I don't see Jira or Slack integrations — want to set those up now, or skip for later?"

For any missing integrations the user wants, walk them through setup:
- Explain what the integration enables (e.g., "Google Workspace lets me check your calendar, read shared docs, and manage meeting agendas")
- Point them to the relevant MCP server setup (e.g., `claude mcp add` commands, or plugin install instructions)
- After setup, verify the connection works with a test call
- Don't block on any single integration — offer to continue without it

**Priority order matters**: Google Workspace unlocks the most discovery (calendar = people + meetings). Glean unlocks Slack search (team channels, comms style, org context). Everything else is nice-to-have.

### 2. Identity

Ask just two things:
- **Name**: "What's your name?"
- **Role**: "What's your title and team/org?" (e.g., "Senior Engineering Manager, Payments at Acme Corp")

That's it for manual input. Everything else comes from discovery.

### 3. Auto-Discovery

Use available integrations to build a picture of the user's world. Run these in parallel where possible:

**From Calendar** (if Google Workspace available):
- Pull the next 2 weeks of calendar events
- Identify **recurring 1:1s**: events with exactly 2 attendees that repeat weekly or biweekly. For each, extract:
  - The other person's name and email
  - Cadence (weekly, biweekly, monthly)
  - Whether it's currently active (not declined, not cancelled)
- Identify **recurring meetings** (3+ attendees, recurring): team syncs, standups, leadership meetings, reviews. For each, extract:
  - Meeting name, cadence, attendee list
  - Any linked Google Doc (from event description)
- Identify the user's **manager**: look for a 1:1 where the other person is more senior (check title via Glean people search if available), or just flag the most frequent 1:1 partner for confirmation

**From Glean** (if available):
- Search for the user's name with `app: people` to get their org info, team, and manager
- Search team Slack channels (look for `#team-`, `#eng-`, `#proj-` patterns) to identify teams and active projects
- Pull a few recent Slack messages from the user to seed comms style analysis

**From Jira** (if available):
- List visible projects to identify active workstreams
- Search for recent issues assigned to the user

### 4. Present Findings

Show everything discovered in a clear summary for confirmation. Format:

> **Here's what I found:**
>
> **You**: [Name], [Title] at [Company]
> **Manager**: [Name] (based on [source])
>
> **Your 1:1s** (from calendar):
> | Person | Cadence | Category (guess) |
> |--------|---------|-------------------|
> | Alex Kim | Weekly | Direct report |
> | Jordan Lee | Biweekly | Peer |
> | Sam Chen | Weekly | Manager |
>
> **Recurring meetings**:
> | Meeting | Cadence | Attendees |
> |---------|---------|-----------|
> | Payments Standup | Daily | 8 people |
> | Eng Leadership | Weekly | 5 people |
>
> **Teams/channels I see you in**: #payments-eng, #payments-growth, #proj-checkout-v2
>
> **Does this look right? Anything to add, remove, or recategorize?**

Let the user correct relationship categories (direct report vs. peer vs. skip-level), add missing people, remove irrelevant meetings, etc. This is the one place we have a real conversation — but it's confirming a draft, not building from scratch.

### 5. Build the System

After confirmation, create everything:

**CLAUDE.md** — Populate the personal context section:
- Role, Teams (from confirmed data)
- Key People (from confirmed 1:1 list + any manual additions)
- Comms Style (from Slack message analysis if available, otherwise leave blank with a note it builds over time)
- Preferences (keep the defaults, ask if they want to customize anything)
- Integrations (list what's connected)

**1:1 folders** — For each confirmed person with a regular 1:1:
1. Determine relationship category (from user's confirmation)
2. Create `areas/one-on-ones/<category>/<name>/README.md` with name, role, team, cadence
3. Create `areas/one-on-ones/<category>/<name>/sessions/.gitkeep`

**Meeting folders** — For each confirmed recurring meeting:
1. Create `areas/meetings/<meeting-id>/README.md` with cadence, attendees, linked doc
2. Create `areas/meetings/<meeting-id>/sessions/.gitkeep`

**Projects** — For each identified active project/initiative:
1. Create `projects/<id>/README.md`
2. Add row to `projects/INDEX.md`

Update `areas/one-on-ones/README.md` and `areas/meetings/README.md` with the full listings.

### 6. Style Guide

If Slack messages were found via Glean, analyze them and seed `style-guide.md` with observed patterns (greeting style, sign-off patterns, formatting preferences, tone). Otherwise, explain it builds automatically as they edit drafts.

### 7. Git Setup

- Run `git add -A && git status` to show what was created
- Offer to make an initial commit

### 8. Web UI Setup

After the commit, offer to set up the visual editor:
> "Everything's committed. There's also a web UI that gives you a Google Docs-like editor for all these files — makes browsing and editing much nicer than raw markdown. Want me to get that running? It just takes a minute. (Requires Node.js 22+)"

If they say yes, run `/ui`. If they decline or don't have Node.js, no problem — move on.

### 9. Next Steps

Briefly mention what they can do next:
- `/morning-briefing` — Get a prioritized daily briefing
- "Add a task: [something]" — Start capturing work
- `/prep-1on1 [name]` — Prep for an upcoming 1:1

Keep this to 2-3 lines.

## Rules

- **Discover first, ask second.** The goal is to minimize manual input. If an integration can answer a question, don't ask the user.
- **One confirmation step, not twenty.** Gather everything, present it all at once, let the user correct. Don't ask about each person/meeting individually.
- **Graceful degradation.** No integrations? Fall back to asking questions (the old way). One integration? Use what you have and ask about the rest. All integrations? Almost fully automatic.
- **Don't block on setup.** If the user doesn't want to set up an integration now, skip it and move on. They can add it later.
- Keep the system section of CLAUDE.md (above the `---`) intact — only populate the personal section below it.
- Be conversational, not interrogative. This should feel like a smart colleague who did their homework, not a form.
- Use the existing file templates and conventions already in the repo.
