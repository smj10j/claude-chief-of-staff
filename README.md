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
- **Daily briefings** — cross-references your tasks, calendar, and projects to recommend what to prioritize and which meetings matter most
- **GTD workflow** — inbox capture, processing, next actions, waiting-for, someday/maybe

## Philosophy

- **Local-first**: everything is markdown/YAML in a git repo on your machine
- **Areas vs. projects**: ongoing responsibilities (areas) never complete; time-bound work (projects) has a finish line and gets archived
- **Context over memory**: Claude reads your files each session rather than relying on chat history
- **Progressive personalization**: starts generic, learns your style and preferences over time

## Getting started

### Quick install

Make sure you have [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed, then run:

```bash
curl -fsSL https://raw.githubusercontent.com/smj10j/claude-chief-of-staff/main/install.sh | bash
```

Then follow the instructions it prints — open the directory in Claude Code and type `/init`. Claude will walk you through an interactive onboarding (~5 minutes): your role, your people, your meetings, and writing style.

Once you're set up, try:
- "What's on my list today?"
- "Prep for my 1:1 with [name] tomorrow"
- "Add a task: review Q2 roadmap by Friday"
- "Draft a Slack message to my team about [topic]"

<details>
<summary>Manual setup</summary>

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

</details>

## Commands

Custom slash commands live in `.claude/commands/`. These are the built-in ones:

| Command | Description |
|---------|-------------|
| `/init` | Interactive onboarding - populates CLAUDE.md with your role, people, teams, and creates folder structure |
| `/morning-briefing` | Prioritized daily briefing: calendar, tasks, 1:1 prep, signals, project milestones |
| `/weekly-review` | Friday GTD review: archive done tasks, triage overdue, check project health, preview next week |
| `/prep-1on1 [name]` | Full 1:1 prep workflow: reads README + last session, gathers context, generates session file |
| `/task-triage` | Surface overdue/stale tasks, recommend actions (re-date, drop, delegate), execute after confirmation |
| `/review-launch-tracker` | Review a launch tracker spreadsheet: flag unapproved items, missing artifacts, stale dates, and missing launches |
| `/ui` | Start the Chief of Staff web UI — a WYSIWYG markdown editor at localhost:3737 |
| `/publish-to-gdoc` | Render a markdown file into a formatted Google Doc (requires google-workspace MCP) |
| `/process-ui-annotations [file]` | Process annotations left in the web UI — Claude reads your instructions and applies changes |
| `/upstream-review` | Review local changes and port generalizable ones back to the template repo (see [Contributing back](#contributing-back)) |

You can add your own commands by creating `.md` files in `.claude/commands/`.

## Web UI

The system includes a local web UI for browsing and editing your files in a Google Docs-like experience. Instead of reading markdown in VS Code, you get a WYSIWYG rich text editor with:

- Floating toolbar (select text for formatting)
- Auto-save (changes write back to your markdown files)
- Sidebar navigation for all people, meetings, projects, and reference files
- Collapsible sidebar groups — major sections expanded, nested items (sessions, project files) collapsed by default
- **Cmd+K quick search** — command palette for fuzzy file search with keyboard navigation
- Task dashboard
- Dark mode (follows system preference)
- Cmd+click internal links to navigate between files
- Live reload — changes from Claude or the filesystem appear automatically

### Annotations

The UI supports inline annotations for collaborating with Claude asynchronously:

1. **Select text** in the editor and click the pencil icon in the floating toolbar
2. **Type an instruction** — what you want Claude to do with that section (rewrite, expand, research, restructure, etc.)
3. The text highlights in amber. Annotations **persist immediately** — navigate away and they'll still be there when you come back.
4. Click **"Process with Claude"** in the header to have Claude read your annotations and apply the changes, streaming progress in a modal overlay.

This turns the UI into a two-way collaboration surface: you mark up documents with instructions, Claude carries them out. You can also trigger processing from the terminal with `/process-ui-annotations [file]`.

To start the UI, type `/ui` in Claude Code. First run installs dependencies automatically (requires Node.js 18+). The UI runs at `http://localhost:3737`. Stop it with `/ui stop`.

Edits you make in the browser save to disk, and changes Claude makes to your files show up in the browser automatically.

## Optional integrations

The system works standalone with just Claude Code, but it's designed to plug in data sources via MCP servers for richer context:

- **Slack search** (e.g., Glean MCP) — lets Claude research recent conversations during 1:1 and meeting prep
- **Notion** — for shared/collaborative docs and databases
- **Calendar** (e.g., google-workspace MCP) — enables calendar-aware daily briefings, meeting prioritization, and inserting 1:1 agendas directly into shared Google Docs
- **Jira/Linear** — for cross-referencing engineering work items

These are configured in the `## Integrations` section of CLAUDE.md during or after initialization. The 1:1 prep process gracefully degrades without them — it just works from your local notes instead of also pulling recent Slack threads.

## File structure

```
claude-chief-of-staff/
  CLAUDE.md              # System instructions + your personal context
  style-guide.md         # Your writing style (built over time)
  google-docs-style-guide.md  # Google Docs formatting via Apps Script
  tasks.yaml             # Structured task database (active tasks only)
  tasks-archive.yaml     # Completed tasks organized by week
  recurring.yaml         # Tasks that repeat indefinitely
  inbox.md               # Raw capture - process into other lists
  waiting-for.md         # Delegated items you're tracking
  someday-maybe.md       # Ideas for later
  reading-list.md        # Articles, videos, resources to consume
  .claude/commands/      # Custom slash commands
  ui/                    # Chief of Staff web UI (WYSIWYG editor, start with /ui)
  projects/
    INDEX.md             # Project registry (active, on hold, archived)
    <project-id>/        # One folder per active project
  areas/
    one-on-ones/         # 1:1 system (per-person folders with README + sessions)
    meetings/            # Recurring meetings (same pattern)
    daily-briefings/     # Morning briefing history (sessions/YYYY-MM-DD.md)
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

## Contributing back

If you've forked this repo and built improvements that would benefit others, use the `/upstream-review` command. It diffs your instance against the template repo, identifies generalizable changes (new commands, workflow improvements, structural changes), strips out personal content, and offers to open a PR back to the template.

The rule: personal content (names, tasks, session notes, career details) never goes upstream. System structure, workflow improvements, and new commands do.
