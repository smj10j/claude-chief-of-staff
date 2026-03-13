# Claude Chief of Staff

A personal work management system powered by [Claude Code](https://claude.ai/code), inspired by Getting Things Done (GTD).

Claude acts as your chief of staff — managing tasks, preparing for meetings, drafting comms, and maintaining context across sessions. Everything lives in plain markdown and YAML files in a local git repo. No databases, no SaaS, no vendor lock-in.

## Who it's for

Engineering managers, tech leads, and anyone who manages people + projects and wants an AI assistant that actually knows their world.

## What it does

- **Task tracking** via structured YAML with priorities, due dates, projects, and tags
- **1:1 prep** — reads persistent context about each person, researches recent activity, generates session agendas
- **Meeting prep** — same pattern for recurring team meetings and forums
- **Project lifecycle** — tracks active projects from start to archive
- **Comms drafting** — learns your writing style and drafts messages in your voice
- **GTD workflow** — inbox capture, processing, next actions, waiting-for, someday/maybe

## Philosophy

- **Local-first**: everything is markdown/YAML in a git repo on your machine
- **Areas vs. projects**: ongoing responsibilities (areas) never complete; time-bound work (projects) has a finish line and gets archived
- **Context over memory**: Claude reads your files each session rather than relying on chat history
- **Progressive personalization**: starts generic, learns your style and preferences over time

## Getting started

### Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and configured

### Setup

1. Clone this repo:
   ```bash
   git clone https://github.com/smj10j/claude-chief-of-staff claude-chief-of-staff
   cd claude-chief-of-staff
   ```

2. Start Claude Code in the directory:
   ```bash
   claude
   ```

3. Run the initialization:
   ```
   /init
   ```

   Claude will walk you through an interactive onboarding: your role, your people, your meetings, active projects, and writing style. This populates the CLAUDE.md and creates all the folder structure.

4. Start working. Some things to try:
   - "What's on my list today?"
   - "Prep for my 1:1 with [name] tomorrow"
   - "Add a task: review Q2 roadmap by Friday"
   - "Draft a Slack message to my team about [topic]"

## Optional integrations

The system works standalone with just Claude Code, but it's designed to plug in data sources via MCP servers for richer context:

- **Slack search** (e.g., Glean MCP) — lets Claude research recent conversations during 1:1 and meeting prep
- **Notion** — for shared/collaborative docs and databases
- **Calendar** — for awareness of upcoming meetings and scheduling context
- **Jira/Linear** — for cross-referencing engineering work items

These are configured in the `## Integrations` section of CLAUDE.md during or after initialization. The 1:1 prep process gracefully degrades without them — it just works from your local notes instead of also pulling recent Slack threads.

## File structure

```
work-agent/
  CLAUDE.md              # System instructions + your personal context
  style-guide.md         # Your writing style (built over time)
  tasks.yaml             # Structured task database
  recurring.yaml         # Tasks that repeat indefinitely
  inbox.md               # Raw capture — process into other lists
  waiting-for.md         # Delegated items you're tracking
  someday-maybe.md       # Ideas for later
  reading-list.md        # Articles, videos, resources to consume
  projects/
    INDEX.md             # Project registry (active, on hold, archived)
    <project-id>/        # One folder per active project
  areas/
    one-on-ones/         # 1:1 system (per-person folders with README + sessions)
    meetings/            # Recurring meetings (same pattern)
    career/              # Promotion tracking, growth plans
    comms/               # Drafted messages
  archive/               # Completed projects (moved from projects/)
```

## How it evolves

The system gets better as you use it:
- **Style guide** fills in as you edit Claude's drafts or give feedback
- **1:1 READMEs** accumulate context about each person over time
- **Session files** create a searchable history of what you discussed and decided
- **Tasks** build up a record of what you've shipped

Commit periodically so you have a timeline of when things changed.
