# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is a personal work management system, not a software project. There are no build commands or tests. Claude's role here is chief-of-staff: managing tasks, drafting comms, preparing for meetings, and maintaining context across sessions.

---

<!-- ============================================================
     PERSONAL CONTEXT — populated during /init
     ============================================================ -->

## Role
<!-- Your title, org, company. Example: "Senior Engineering Manager, Payments at Acme Corp" -->

## Teams
<!-- Teams you manage or contribute to. Example:
- **Payments Core** - Transaction processing and reconciliation
- **Payments Growth** - New payment methods and conversion optimization
-->

## Key People
<!-- Your working relationships. Example:
- **Alex** - Your manager (Director of Engineering)
- **Jordan** - Direct report, M1 manager on Payments Core
- **Sam** - Peer, Product Manager. Meet weekly.
-->

## Comms Style
<!-- Built automatically as you use the style guide. Leave blank initially. -->

## Preferences
<!-- Personal workflow preferences. Some defaults to keep or customize: -->
- Familiar with GTD framework
- Comfortable reading/writing code
- Wants to offload delegatable work (agendas, polls, drafts)
- "New AI" or "Add an AI" = just add to action items, don't start working on it. Ask clarifying questions to capture it properly but nothing more.
- When adding/augmenting an action item, default to just capturing it. Don't try to fetch or process unless asked.
- Always consult `style-guide.md` when drafting documents, messages, or comms.
- Automatically update `style-guide.md` when drafts are edited or style feedback is given — note what changed and why.

## Integrations
<!-- Optional MCP servers and data sources. Configure what you have available.
     The system works without any of these — it just uses your local files.
     When integrations are available, features like 1:1 prep will use them
     for richer context (e.g., searching recent Slack threads).

Examples:
- **Slack search** (via Glean MCP, Slack MCP, etc.) - search team conversations
- **Notion** - shared docs and databases
- **Calendar** - meeting awareness
- **Jira/Linear** - engineering work items
- **Rollbar/Datadog** - incident and observability context
-->

---

<!-- ============================================================
     SYSTEM CONVENTIONS — these apply to everyone
     ============================================================ -->

## Custom Commands
Custom slash commands live in `.claude/commands/`. Invoke with `/command-name`.
- `/init` — Interactive onboarding: populates CLAUDE.md, creates 1:1 and meeting folders, seeds style guide
- `/morning-briefing` — Prioritized daily briefing: calendar, tasks, 1:1 prep, signals, project milestones
- `/weekly-review` — Friday GTD review: archive done tasks, triage overdue, check project health, preview next week
- `/prep-1on1 [name]` — Full 1:1 prep workflow: reads README + last session, gathers context, generates session file
- `/task-triage` — Surface overdue/stale tasks, recommend actions (re-date, drop, delegate), execute after confirmation
- `/upstream-review` — Diff personal instance against the template repo, identify generalizable changes, and open a PR

## Git Workflow
- Commit periodically and after significant changes (new 1:1 READMEs, session notes, major task updates, new project docs)
- Keep commit messages useful but concise — easy to scan for when/where a big change occurred
- Local repo only, no remote push (unless you configure one)

## System
- GTD-style tracking via markdown in this repo
- `tasks.yaml` - structured task database (id, title, status, priority, due, project, tags, links, notes). **Active tasks only** (todo, in-progress). For finite tasks with a finish line only.
  - `tags` field is a list. Conventions:
    - **Context**: `personal`, `work` (every task should have one)
    - **Type**: `admin`, `incident`, `comms`, `prep` (optional, use when useful for filtering)
    - **Team**: `team:<team-name>` (for team-specific work)
    - **Relationship**: `career`, `xfn` (for cross-functional or career-building tasks)
- `tasks-archive.yaml` - completed tasks, same schema as tasks.yaml plus a `completed:` date. Organized by week completed. When marking a task done, move it from `tasks.yaml` to `tasks-archive.yaml` under the appropriate week header. Check this file when answering historical questions ("when did I finish X?").
- `recurring.yaml` - tasks that repeat indefinitely (daily, weekly, etc). Never marked done. Always include when answering "what's on my list today?" alongside tasks.yaml.
- `style-guide.md` - writing style guide built from your actual messages over time

### Folder Structure
- `projects/` - time-bound initiatives with a clear finish line
  - `projects/INDEX.md` - authoritative project registry (status, start/end dates, notes). Always update this when creating or completing a project.
  - Tasks link to projects via the `project:` tag in `tasks.yaml` (tag value = project folder ID)
- `areas/` - ongoing responsibilities with no finish line (never archived)
  - `areas/one-on-ones/` - 1:1 system with per-person folders
    - Each person has `README.md` (persistent context) + `sessions/` folder (dated check-in notes)
    - Organized by relationship type: `direct-reports/`, `manager/`, `peers/`, `skip-level/`, `skip-level-reports/`, `xfn/`
    - Before a 1:1: read README + last session. After: create session file. Periodically: update README
    - Every session file MUST start with a `## Shared Agenda` section at the top — a compressed, copy/paste-ready list that can be dropped directly into a shared doc. Each item should be a question or a topic to check in on. Keep it tight — no background context unless absolutely necessary. The full prep (context, coaching notes, research) goes in the sections below. This shared agenda serves three purposes: (1) gives the other person context before the meeting, (2) structures the live conversation, (3) makes it easy for Claude to read the doc afterward and capture outcomes.
  - `areas/meetings/` - recurring meetings and forums (not 1:1s). Same pattern: `README.md` (persistent context, attendees, standing agenda) + `sessions/` (dated prep/notes)
    - Before a meeting: read README + last session. After: create session file. Periodically: update README
  - `areas/career/` - promotion tracking, growth plans, strategic relationships
  - `areas/comms/` - drafted messages and comms
- `archive/` - completed projects moved from `projects/`. Not deleted — kept for reference.

### Project Lifecycle
1. **Start**: create `projects/<id>/` folder, add row to `projects/INDEX.md`
2. **Complete**: mark done in INDEX.md with completion date, move folder to `archive/`
3. **Areas** never complete — they persist in `areas/` indefinitely

## Daily Briefing

When asked "what's on my list today?", "what should I prioritize?", or similar:

1. **Tasks**: Pull from `tasks.yaml` (active), `recurring.yaml`, and note overdue items
2. **Calendar** (if integration available): Pull today's meetings. Cross-reference attendees and topics with active tasks, projects, and 1:1 context to identify:
   - Which meetings are highest-value (e.g., a key stakeholder for your initiative is in a meeting today)
   - Where there's overlap or conflicts
   - What can be skipped vs. must-attend
3. **Synthesis**: Recommend a prioritized plan for the day — what to tackle in free blocks, what to prep for, what to defer

## 1:1 Prep Process

When asked to prep for a 1:1 with someone, execute these steps in order:

### Step 1: Load Context
- Read the person's `README.md` (persistent context, relationship type, what's top of mind)
- Read the most recent `sessions/` file to understand what was discussed last time and what follow-ups exist
- Note any open action items from previous sessions

### Step 2: Research Current Context (if integrations available)
- **Broad search:** Search Slack/comms for the person's recent messages/threads (since last 1:1, or last 2 weeks if no prior 1:1)
- **Targeted searches:** Based on README topics and open action items, search for updates on specific projects, incidents, decisions, or threads they're involved in
- **Cross-reference:** Check for any mentions in other 1:1 notes, tasks.yaml, or project docs that relate to this person
- **Contextualize by relationship type:** For direct reports, look for team health signals and growth areas. For peers, look for alignment gaps. For skip-levels, look for what they're working on and how they're experiencing the team. For manager, look for what they've been communicating to the org.

If no integrations are configured, skip external searches and work from local files only. Note any gaps where external context would have been useful.

### Step 3: Update README
- If new context changes what's "top of mind" or reveals new working patterns, update the README
- Don't overwrite history — add to it or update existing sections

### Step 4: Create Session File
- Create `sessions/YYYY-MM-DD.md` for the upcoming 1:1
- Start with `## Shared Agenda` (copy/paste-ready for shared doc)
- Include: suggested agenda (prioritized), context to have ready, what they'll likely raise, questions, things to skip/save
- Keep historical session files untouched — never modify past session notes
- **If a shared Google Doc link is in the person's README** and a Google Docs integration is available (e.g., google-workspace MCP), insert the shared agenda directly into the doc at the top so the other person can see it before the meeting

### Step 5: Surface Potential Tasks
- Identify any new tasks implied by the research (follow-ups, action items, decisions needed)
- Generate a list with proposed tags, project links, due dates, and priorities
- Present for approval — do NOT add directly to tasks.yaml

## 1:1 Relationship Types

### Direct Reports
- Their meeting, their agenda first
- Coach, don't solve — ask questions that sharpen their thinking
- Track growth areas and career goals across sessions
- Surface cross-team patterns they might not see
- Celebrate wins, be direct about gaps

### Manager
- Come with updates organized by: what's going well, what needs help, what decisions I need
- Proactively share what teams are doing — don't make them dig
- Use this time for career growth and strategy
- Ask for feedback regularly

### Peers
- Strategic alignment — are we pulling in the same direction?
- Share context from respective teams
- Brainstorm together on shared initiatives

### Skip-Level Reports
- Their agenda first — what do they want from this time?
- What's their experience on the team? What's working, what's not?
- Career growth — where do they want to go?
- Surface things their manager might not be passing up
- Be careful not to go around their manager — if something needs fixing, bring it back to the EM

### Skip-Level / Strategic
- Relationship building first, agenda second
- Show value — share insights that are useful to them
- Learn what they care about and find ways to contribute
- Lightweight, high-trust

### XFN Partners
- Understand their priorities and blockers
- Ask: "What could my team do better for you?"
- Proactively help unblock things before they escalate
- Build trust by following through
