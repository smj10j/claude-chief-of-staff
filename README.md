# Claude Chief of Staff

A personal work management system powered by [Claude Code](https://claude.ai/code), inspired by Getting Things Done (GTD).

Claude acts as your chief of staff — managing tasks, preparing for meetings, drafting comms, and maintaining context across sessions. Everything lives locally — markdown files and a SQLite database in a git repo on your machine. No SaaS, no vendor lock-in.

## Who it's for

Engineering managers, tech leads, and anyone who manages people + projects and wants an AI assistant that actually knows their world.

## What it does

- **Task tracking** via SQLite database with a CLI — priorities, due dates, projects, and tags
- **1:1 prep and digest** — reads persistent context + past sessions + Slack activity, generates session agendas. After the meeting, digests notes into structured outcomes and follow-ups
- **Meeting prep** — same pattern for recurring team meetings and forums
- **Project lifecycle** — tracks active projects from start to archive
- **Comms drafting** — learns your writing style and drafts messages in your voice
- **Daily briefings** — cross-references your tasks, calendar, and projects to recommend what to prioritize and which meetings matter most
- **Weekly review** — Friday GTD review: triage overdue tasks, check project health, compact old sessions, preview next week. Output persisted for Monday reference
- **Session compaction** — automatically compresses old session files to structured summaries while preserving coaching signals. Originals archived for search
- **Overdue notifications** — pushes overdue tasks to your phone via Apple Reminders
- **Leveling assessments** — IC candidate leveling against your company's competency framework
- **GTD workflow** — inbox capture, processing, next actions, waiting-for, someday/maybe

## Philosophy

- **Local-first**: everything is markdown + SQLite in a git repo on your machine
- **Areas vs. projects**: ongoing responsibilities (areas) never complete; time-bound work (projects) has a finish line and gets archived
- **Context over memory**: Claude reads your files each session rather than relying on chat history
- **Progressive personalization**: starts generic, learns your style and preferences over time

## Getting started

### Quick install

Make sure you have [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and Node.js 22+ installed (for the built-in SQLite module), then run:

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

### Set up automation

Two background agents run on schedules via macOS launchd. Both are optional but recommended — they keep the system healthy without you having to remember.

**Overdue task notifications** (daily at 8 AM):
```bash
bash bin/reminders/overdue-notifier-setup.sh install
```
Checks for overdue tasks every morning and creates Apple Reminders with alarms so they push to your phone. Read-only — never modifies the task database. You'll be prompted to grant Reminders access on first run. See `bin/reminders/README.md` for full docs.

**Weekly review** (Fridays at 8 PM):
```bash
bash bin/weekly-review/weekly-review-setup.sh install
```
Runs Claude Code non-interactively every Friday evening. Triages overdue tasks, checks project health, compacts old session files, and saves a review artifact to `data/files/areas/weekly-reviews/sessions/`. Read the output Monday morning to orient your week.

Both agents:
```bash
# Check status
bash bin/reminders/overdue-notifier-setup.sh status
bash bin/weekly-review/weekly-review-setup.sh status

# Change schedule
NOTIFIER_HOUR=9 bash bin/reminders/overdue-notifier-setup.sh install   # 9 AM
REVIEW_HOUR=19 bash bin/weekly-review/weekly-review-setup.sh install   # 7 PM

# Uninstall
bash bin/reminders/overdue-notifier-setup.sh uninstall
bash bin/weekly-review/weekly-review-setup.sh uninstall

# Logs
cat data/logs/overdue-notifier.log
cat data/logs/weekly-review.log
```

## Commands

Custom slash commands live in `.claude/commands/`. These are the built-in ones:

| Command | Description |
|---------|-------------|
| `/init` | Interactive onboarding - populates CLAUDE.md with your role, people, teams, and creates folder structure |
| `/morning-briefing` | Prioritized daily briefing: calendar, tasks, 1:1 prep, signals, project milestones |
| `/weekly-review` | Friday GTD review: triage overdue tasks, check project health, compact old sessions, preview next week. Persists output to `data/files/areas/weekly-reviews/` |
| `/prep-1on1 [name]` | Full 1:1 prep workflow: reads README + last sessions, gathers Slack/task context, generates session file with shared agenda |
| `/digest-meeting [name]` | Digest notes from a completed 1:1 or meeting: reads shared Google Doc + raw notes, structures session notes, updates READMEs, proposes task updates |
| `/compact-sessions` | Compact old session files to structured summaries, archive originals. Runs automatically in `/weekly-review`, or standalone for ad-hoc use |
| `/task-triage` | Surface overdue/stale tasks, recommend actions (re-date, drop, delegate), execute after confirmation |
| `/review-reminders` | Import pending items from Apple Reminders into the task database. Also runs during `/morning-briefing` |
| `/level-candidate` | IC leveling assessment against the engineering competency framework |
| `/review-launch-tracker` | Review a launch tracker spreadsheet: flag unapproved items, missing artifacts, stale dates, and missing launches |
| `/publish-to-gdoc` | Render a markdown file into a formatted Google Doc (requires google-workspace MCP) |
| `/process-ui-annotations [file]` | Process inline annotations dropped on a markdown file (`<file>.annotations.json` sidecar) — Claude reads each instruction and applies the change |
| `/task-export` | Export the task database to YAML files for backup or debugging |
| `/internal-consistency-check` | Audit repo for internal inconsistencies: missing READMEs, mismatched listings, stale sessions |
| `/upstream-review` | Review local changes and port generalizable ones back to the template repo (see [Contributing back](#contributing-back)) |

You can add your own commands by creating `.md` files in `.claude/commands/`.

## Desktop app (v2)

A native desktop app — Tauri 2 with a React/TypeScript frontend and Rust backend — provides a WYSIWYG editing surface over the same content tree. Source lives in `v2/app/`.

- **Tabbed workspace** — Cmd+T new tab, Cmd+W close, Cmd+1..9 switch, Cmd+Shift+T reopen, drag to reorder, pin to keep something parked, right-click for the action menu, ⌘K palette indexes open tabs
- **WYSIWYG editor** with floating toolbar, auto-save, table support, code blocks, internal links
- **Sidebar** with all people, meetings, projects, areas, recents, and pinned docs
- **Cmd+K command palette** — fuzzy search for files, people, tasks, projects, and slash-command actions
- **Task dashboard, calendar, ops + velocity surfaces, planning views** — see `cos-dev/PRDs/v2/` for the feature surface
- **Themes** — light/dark, multiple palettes, density + text-size controls
- **Live reload** — changes Claude makes to files on disk show up instantly

### Annotations

Drop inline instructions on a markdown file for Claude to act on later — a two-way collaboration surface:

1. **Select text** in the editor and add an annotation
2. **Type an instruction** — what you want Claude to do with that section (rewrite, expand, research, restructure, etc.)
3. The text highlights and the instruction is saved to a `<file>.annotations.json` sidecar next to the markdown
4. Run `/process-ui-annotations [file]` (from terminal or the in-app button) — Claude reads each annotation, applies the change, and clears the entry

### Running

```bash
cd v2/app
npm install
npm run tauri dev   # dev mode with hot reload
# or:
npm run tauri build # produces a signed .dmg in src-tauri/target/release/bundle/dmg/
```

Edits you make in the app save to disk, and changes Claude makes to your files show up in the app automatically.

## Optional integrations

The system works standalone with just Claude Code, but it's designed to plug in data sources via MCP servers for richer context. Each integration auto-prompts for OAuth the first time you use a command that needs it — no manual setup required, just authenticate when your browser opens.

| Integration | What it enables | First prompt trigger |
|---|---|---|
| **Slack** (slack-local-mcp) | Search, read, send messages, create drafts | First `/morning-briefing` or Slack-related question |
| **Google Workspace** | Calendar, Sheets, Slides, Docs | First `/morning-briefing` (calendar) or doc access |
| **Glean** | Cross-source search (Slack + Confluence + Drive) | First Glean search fallback |
| **Atlassian** (Jira/Confluence) | Ticket operations, Confluence search | First `/jira` or ticket command |
| **Datadog** | Log/trace/dashboard queries | First Datadog query |

The 1:1 prep process gracefully degrades without integrations — it just works from your local notes instead of also pulling recent Slack threads.

**GitHub MCP** (optional, for PR workflows):
```bash
curl -L https://github.com/github/github-mcp-server/releases/latest/download/github-mcp-server-darwin-arm64.tar.gz | tar xz -C ~/.local/bin
```
Then run `/chime-github:github-setup` in Claude Code for guided configuration.

## File structure

```
claude-chief-of-staff/
  CLAUDE.md                # System instructions + your personal context (Claude reads this every session)
  README.md                # This file (for humans)
  .claude/commands/        # Custom slash commands
  .nvmrc                   # Node.js version (22+ required for built-in SQLite)
  bin/                     # Tooling scripts (template code)
    cos                    #   Headless CLI — `bash bin/cos --help` for full surface
    md-to-gdoc-payload.js  #   Google Docs publishing helper
    db/                    #   Task database tooling (delegated to from bin/cos)
      task-cli.sh          #     nvm-aware wrapper — bin/cos calls this
      task-cli.js          #     Task CLI (list, add, done, archive, etc.)
      task-db.js           #     Shared data access module (used by CLI and UI)
      migrations/          #     SQL schema migrations (applied automatically)
      tests/               #     Unit and integration tests (node --test)
    reminders/             #   Apple Reminders integration
      apple-reminders.sh   #     Swift adapter (auto-compiles on first run)
      overdue-notifier.sh  #     Checks for overdue tasks, creates phone reminders
      overdue-notifier-setup.sh  # Install/uninstall the daily launchd agent
    weekly-review/         #   Weekly review automation
      weekly-review-runner.sh    # Invokes Claude Code CLI non-interactively
      weekly-review-setup.sh     # Install/uninstall the Friday launchd agent
  data/                    # All user-specific data
    cos.db                 #   SQLite task database (auto-created on first run)
    logs/                  #   Automation logs (overdue-notifier, weekly-review)
    files/                 #   User content files
      inbox.md             #     Raw capture - process into other lists
      waiting-for.md       #     Delegated items you're tracking
      someday-maybe.md     #     Ideas for later
      reading-list.md      #     Articles, videos, resources to consume
      style-guide.md       #     Your writing style (built over time)
      projects/
        INDEX.md           #     Project registry (active, on hold, archived)
        <project-id>/      #     One folder per active project
      areas/
        one-on-ones/       #     1:1 system (per-person folders with README + sessions)
        meetings/          #     Recurring meetings (same pattern)
        daily-briefings/   #     Morning briefing history (sessions/YYYY-MM-DD.md)
        weekly-reviews/    #     Friday weekly review artifacts (sessions/YYYY-MM-DD.md)
        career/            #     Promotion tracking, growth plans
        comms/             #     Drafted messages
      archive/             #     Completed projects (moved from projects/)
  v2/app/                  # Tauri desktop app — Rust + React/TypeScript
  cos-dev/                 # Development documentation (PRDs, implementation loop)
```

## How it evolves

The system gets better as you use it:
- **Style guide** fills in as you edit Claude's drafts or give feedback
- **1:1 READMEs** accumulate context about each person over time
- **Session files** create a searchable history of what you discussed and decided
- **Tasks** build up a record of what you've shipped
- **Weekly reviews** build a longitudinal record of project health and task patterns

### Session compaction

As session files accumulate, Claude automatically compacts older ones during the weekly review to keep things manageable:

- **Last 3 sessions** per person/meeting stay full-fidelity
- **Older sessions** are compacted to structured summaries (~15-25 lines) with key outcomes, follow-ups, and coaching signals preserved
- **Originals** are moved to `sessions/archive/` for grep/search — nothing is deleted
- **Daily briefings** compact more aggressively (anything older than 2 weeks)

This keeps Claude's context window efficient while preserving all information. Run `/compact-sessions --dry-run` to preview what would be compacted, or let it happen automatically on Fridays.

Commit periodically so you have a timeline of when things changed.

## Contributing back

If you've forked this repo and built improvements that would benefit others, use the `/upstream-review` command. It diffs your instance against the template repo, identifies generalizable changes (new commands, workflow improvements, structural changes), strips out personal content, and offers to open a PR back to the template.

The rule: personal content (names, tasks, session notes, career details) never goes upstream. System structure, workflow improvements, and new commands do.
