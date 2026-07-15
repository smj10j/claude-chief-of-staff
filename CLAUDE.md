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
- When drafting messages, always offer to copy to clipboard via `pbcopy`. Terminal rendering adds leading spaces on wrapped lines, making inline drafts hard to copy/paste. Use `echo -n "message" | pbcopy` to put clean text directly on the clipboard.

## Preferences
<!-- Personal workflow preferences. Some defaults to keep or customize: -->
- Familiar with GTD framework
- Comfortable reading/writing code
- Wants to offload delegatable work (agendas, polls, drafts)
- "New AI" or "Add an AI" = just add to action items, don't start working on it. Ask clarifying questions to capture it properly but nothing more.
- When adding/augmenting an action item, default to just capturing it. Don't try to fetch or process unless asked.
- Always consult `data/files/style-guide.md` when drafting documents, messages, or comms.
- Automatically update `data/files/style-guide.md` when drafts are edited or style feedback is given — note what changed and why.

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

Custom slash commands live in `.claude/commands/`. Invoke with `/command-name`. Each command file is self-describing — open it for full behavior. Grouped for scanning:

**Daily / weekly cadence**
- `/morning-briefing` — Prioritized daily briefing: calendar, tasks, 1:1 prep, signals, project milestones. Pulls in `/ops-*` and `/planning-*` snapshots and `/review-reminders`.
- `/weekly-review` — Friday GTD review: archive done tasks, triage overdue, check project health, preview next week, compact old sessions, persist output to `data/files/areas/weekly-reviews/`. Runs automatically every Friday at 8 PM via scheduled launchd agent.
- `/compact-sessions` — Compact old session files: creates structured summaries, archives originals. Keeps last 3 sessions full-fidelity per person/meeting. Run standalone or as part of `/weekly-review`.
- `/task-triage` — Surface overdue/stale tasks, recommend actions (re-date, drop, delegate), execute after confirmation.
- `/review-reminders` — Import pending items from Apple Reminders into the task database.

**1:1s and meetings**
- `/prep-1on1 [name]` — Full 1:1 prep workflow: reads README + last session, gathers context, generates session file.
- `/digest-meeting [name]` — Digest notes from a completed 1:1 or meeting: structures session file, updates READMEs, proposes task updates.

**Org / People**
- `/org-generate` — Rebuild the canonical `data/files/areas/org/org.json` plus every `person.json`. Same outcome as the v2 UI's "Regenerate" button.
- `/person-refresh [name]` — Refresh one person's `person.json` (Slack/email/title metadata).
- `/level-candidate [name|pdf]` — IC leveling assessment against your engineering leveling framework.

**Ops / Service Health**
- `/ops-incidents` — Snapshot active incidents from your incidents Slack channel.
- `/ops-datadog-monitors` — Snapshot failing Datadog monitors.
- `/ops-rollbar-top` — Snapshot top Rollbar error items across your projects.
- `/ops-my-jira` — Snapshot Jira issues currently assigned to you.
- `/ops-team-jira` — Snapshot Jira issues assigned across your team.
- `/velocity-diagnose` — Diagnose week-over-week PR + Jira velocity dips over the last 14 days.

**Planning / Roadmap**
- `/planning-team-epics` — Snapshot open epics owned by your team (Roadmap tab).
- `/planning-jpd` — Snapshot Jira Product Discovery items (Roadmap → Discovery sub-tab).
- `/planning-epic-update <epic-key>` — Draft a weekly plan-update narrative for one epic.
- `/review-launch-tracker` — Review a launch tracker spreadsheet: flag unapproved items, missing artifacts, stale dates, and missing launches.

**Comms / docs**
- `/publish-to-gdoc` — Render a markdown file into a formatted Google Doc. Optionally pass a doc URL to update in-place.
- `/process-ui-annotations [file]` — Process annotations from `<file>.annotations.json` sidecar. Triggered by the v2 desktop app's "Process with Claude" button or run manually.

**Repo hygiene**
- `/init` — Interactive onboarding: populates CLAUDE.md, creates 1:1 and meeting folders, seeds style guide.
- `/internal-consistency-check` — Audit repo for missing READMEs, mismatched listings, orphaned folders, stale sessions.
- `/upstream-review` — Review local changes and port generalizable ones back to the template repo.
- `/task-export` — Export the task database to YAML files for backup or debugging.

## Git Workflow
- Commit periodically and after significant changes (new 1:1 READMEs, session notes, major task updates, new project docs)
- Keep commit messages useful but concise — easy to scan for when/where a big change occurred
- Local repo only, no remote push (unless you configure one)

## System
- GTD-style tracking via SQLite database (`data/cos.db`) managed through a CLI
- **Task CLI** (`bash bin/db/task-cli.sh`) - primary interface for reading and writing tasks. Use this instead of editing files directly. Always use the `.sh` wrapper (not `node bin/db/task-cli.js` directly) — it sources nvm to ensure Node 22+.
  ```
  bash bin/db/task-cli.sh list                    # Active tasks (compact format)
  bash bin/db/task-cli.sh list --due-by today     # Tasks due today or earlier
  bash bin/db/task-cli.sh list --tag team:payments # Filter by tag
  bash bin/db/task-cli.sh list --archived         # Archived/completed tasks
  bash bin/db/task-cli.sh list --archived --since 2026-03-20  # Recent archive
  bash bin/db/task-cli.sh get <id>                # Single task details
  bash bin/db/task-cli.sh add "Task title" --due 2026-04-01 --priority high --tags work,admin
  bash bin/db/task-cli.sh add "Prep for 1:1" --due "2026-04-01 14:00"  # Due at 2pm
  bash bin/db/task-cli.sh add "Send update" --due "today at 2pm"       # Natural language
  bash bin/db/task-cli.sh update <id> --due "2026-04-15 09:00" --priority medium
  bash bin/db/task-cli.sh done <id>               # Mark done (auto-archives)
  bash bin/db/task-cli.sh archive <id>            # Drop without completing
  bash bin/db/task-cli.sh unarchive <id>          # Return to active list
  bash bin/db/task-cli.sh recurring               # List recurring tasks
  bash bin/db/task-cli.sh --help                  # Full reference
  ```
  - Use `--format json` for full task data (includes notes, links)
  - Use `--format table` for human-readable terminal output
  - Default `compact` format is tab-separated, optimized for token efficiency
  - Tag conventions:
    - **Context**: `personal`, `work` (every task should have one)
    - **Type**: `admin`, `incident`, `comms`, `prep` (optional, use when useful for filtering)
    - **Team**: `team:<team-name>` (for team-specific work)
    - **Relationship**: `career`, `xfn` (for cross-functional or career-building tasks)
- `data/files/inbox.md` - GTD inbox for quick capture. Items here haven't been processed yet — triage them into the task database, someday-maybe.md, or delete.
- `data/files/someday-maybe.md` - ideas and projects to revisit later. Not committed to, but worth keeping visible.
- `data/files/waiting-for.md` - items delegated or blocked on someone else. Track who and when.
- `data/files/reading-list.md` - articles, docs, and resources to read. Can include links and brief notes on why.
- `data/files/style-guide.md` - writing style guide built from your actual messages over time
- `data/files/google-docs-style-guide.md` - formatting conventions for Google Docs edited via Apps Script (bold patterns, spacing, lists, code blocks)

### Folder Structure

The repo separates **template code** (syncs with upstream) from **user data** (unique to your instance):

- `bin/` - tooling scripts (template code)
  - `bin/db/` - task CLI, data access module, migrations, tests
  - `bin/reminders/` - Apple Reminders adapter (Swift/EventKit). `apple-reminders.sh` wrapper auto-compiles `apple-reminders.swift` on first run. Supports `list`, `complete`, `add`, and `update` commands.
    - `bin/reminders/overdue-notifier.sh` - checks the task DB for overdue tasks and creates Apple Reminders with alarms (read-only — never modifies tasks). Tracks notified tasks in `data/.overdue-notified` to avoid duplicates.
    - `bin/reminders/overdue-notifier-setup.sh` - installs/uninstalls a macOS launchd agent that runs the notifier daily at 8:00 AM. Run `bash bin/reminders/overdue-notifier-setup.sh install` to enable.
  - `bin/md-to-gdoc-payload.js` - Google Docs publishing helper
- `data/` - all user-specific data (ignored by upstream review)
  - `data/cos.db` - SQLite task database (auto-created on first run)
  - `data/files/` - all user content files:
    - `data/files/projects/` - time-bound initiatives with a clear finish line
      - `data/files/projects/INDEX.md` - authoritative project registry (status, start/end dates, notes). Always update this when creating or completing a project.
      - Tasks link to projects via the `project` field in the task database (value = project folder ID)
    - `data/files/areas/` - ongoing responsibilities with no finish line (never archived)
      - `data/files/areas/one-on-ones/` - 1:1 system with per-person folders
        - Each person has `README.md` (persistent context) + `sessions/` folder (dated check-in notes)
        - Organized by relationship type: `self/` (your own "You" page), `direct-reports/`, `manager/`, `peers/`, `skip-level/`, `skip-level-reports/`, `xfn/`
        - Direct reports + skip-level reports (and `self/`) also have a `career/` folder (career-development docs, shaped like a project folder — a README overview + optional extra docs). Surfaced in the app's per-person **Career** section. Scaffolded on folder creation; see one-on-ones README → Career Folder. Shared leveling references stay in `data/files/areas/career/`.
        - **Full people listing and folder tree in** `data/files/areas/one-on-ones/README.md` — that file is the source of truth for who has folders and which category they're in
        - **Session workflow also defined in** `data/files/areas/one-on-ones/README.md` — follow this for all prep and digest steps
        - Before a 1:1: read README + last session, generate session doc with empty `## Raw Notes` section. After: digest raw notes, read shared doc if available via integration, update README, update tasks, propose new AIs
        - Every session file MUST start with a `## Shared Agenda` section at the top — a compressed, copy/paste-ready list that can be dropped directly into a shared doc. Each item should be a question or a topic to check in on. Keep it tight — no background context unless absolutely necessary. The full prep (context, coaching notes, research) goes in the sections below. This shared agenda serves three purposes: (1) gives the other person context before the meeting, (2) structures the live conversation, (3) makes it easy for Claude to read the doc afterward and capture outcomes.
      - `data/files/areas/meetings/` - recurring meetings and forums (not 1:1s). Same pattern: `README.md` (persistent context, attendees, standing agenda) + `sessions/` (dated prep/notes)
        - Before a meeting: read README + last session. After: create session file. Periodically: update README
      - `data/files/areas/career/` - promotion tracking, growth plans, strategic relationships
      - `data/files/areas/comms/` - drafted messages and comms
      - `data/files/areas/daily-briefings/` - daily morning briefing history. Same `sessions/YYYY-MM-DD.md` pattern. Auto-written by `/morning-briefing`.
      - `data/files/areas/weekly-reviews/` - Friday weekly review artifacts. Same `sessions/YYYY-MM-DD.md` pattern. Auto-written by `/weekly-review`.
      - `data/files/areas/task-triage/` - working directory for `/task-triage` output (triage.md)
      - `data/files/areas/console-sessions/` - per-tab Console transcripts from the v2 desktop app's multi-tab Console. Naming pattern `YYYY-MM-DD-HHMM-c#.{md,jsonl}` where `c#` is the tab number. Auto-written by the app, not edited by hand.
    - `data/files/archive/` - completed projects moved from `data/files/projects/`. Not deleted — kept for reference.
- `cos-dev/` - Chief of Staff app development documentation
  - `cos-dev/TDD.md` - Technical design document
  - `cos-dev/DESIGN.md` - Design principles guiding UI decisions
  - `cos-dev/SECURITY.md` - Threat model, current controls, security checklist
  - `cos-dev/implementation-loop.md` - Process for implementing PRDs (follow this when building features)
  - `cos-dev/PRDs/` - Product requirement documents
    - `cos-dev/PRDs/INDEX.md` - PRD registry (status, dates, links). Always update this when creating or completing a PRD.
  - `cos-dev/implementations/` - Implementation trackers for completed PRDs (audit trail, soak logs, cleanup checklists)

### Project Lifecycle
1. **Start**: create `data/files/projects/<id>/` folder, add row to `data/files/projects/INDEX.md`
2. **Complete**: mark done in INDEX.md with completion date, move folder to `data/files/archive/`
3. **Areas** never complete — they persist in `data/files/areas/` indefinitely

### Chief of Staff app (v2)

- Native desktop app built on Tauri 2 (Rust + React/TypeScript). Source lives in `v2/app/`.
- Run in dev with `cd v2/app && npm run tauri dev`. A signed `.dmg` is produced by `npm run tauri build` (lands at `v2/app/src-tauri/target/release/bundle/dmg/`).
- The app reads/writes the same on-disk content tree (`data/files/`) and SQLite task DB (`data/cos.db`) the CLI uses, so v2 and `bash bin/cos …` share state.
- Edits in the editor auto-save (2s debounce + flush on close); annotations land as `<file>.annotations.json` sidecars next to the markdown — `/process-ui-annotations` reads them.
- v2 design + architecture docs: `cos-dev/PRDs/v2/` (numbered PRDs starting at 100), `cos-dev/TDD.md`, `cos-dev/DESIGN.md`, `cos-dev/SECURITY.md`.

## Daily Briefing

When asked "what's on my list today?", "what should I prioritize?", or similar — run the `/morning-briefing` command. It handles calendar, tasks, 1:1/meeting prep, signals, and writes a dated briefing file.

## Overdue Task Notifications

A macOS `launchd` agent runs daily at 8:00 AM, checks the task DB for overdue items, and creates Apple Reminders with alarms so they push to the phone. Read-only — never modifies the task database. See `bin/reminders/README.md` for full docs.

```bash
bash bin/reminders/overdue-notifier-setup.sh install     # Enable (daily at 8 AM)
bash bin/reminders/overdue-notifier-setup.sh status      # Check if running
bash bin/reminders/overdue-notifier-setup.sh uninstall   # Disable
bash bin/reminders/overdue-notifier.sh --dry-run         # Preview without creating reminders
NOTIFIER_HOUR=9 bash bin/reminders/overdue-notifier-setup.sh install  # Change time
```

## 1:1 Prep

When asked to prep for a 1:1, run `/prep-1on1 [name]`. The full prep workflow, relationship type guidance, and session template are defined in `data/files/areas/one-on-ones/README.md`.

## Leveling Candidates

When asked to level a candidate, run `/level-candidate [name or PDF path]`. Uses the IC competency framework and personal leveling guidelines if available. See `data/files/areas/career/` for leveling docs.

## Session Compaction

Session files are compacted weekly (as part of `/weekly-review`) to keep context window consumption manageable while preserving all information.

### How It Works
- **Hot (last 3 sessions per person/meeting):** Full fidelity. Read as-is during prep.
- **Warm (4th+ session):** Original moved to `sessions/archive/`. Compact summary added to a single consolidated file per person/area: `sessions/compacted_STARTDATE_to_ENDDATE.md`. Each session is an H2 section within that file.
- **Daily briefings:** More aggressive — anything older than 2 weeks is compacted.
- **Archives:** Originals preserved in `sessions/archive/` for grep/search. Never deleted.

### Prep Behavior
- `/prep-1on1` and `/morning-briefing` read the last 3 full sessions per person. The `compacted_*.md` file is a lightweight reference for longer-term context threads — scan it if needed, but don't load it by default.

### Running Manually
```bash
/compact-sessions              # Compact all candidates
/compact-sessions [name]       # Compact one person
/compact-sessions --dry-run    # Preview without changes
```

## Setup Guide

Steps to set up a new instance of this work management system. Run `/init` first for interactive onboarding, then complete these manual steps.

### Prerequisites
- **Node.js 22+** — required for task CLI, UI, and tooling scripts. Install via nvm: `nvm install 22`
- **macOS** — required for Apple Reminders integration (EventKit/Swift)
- **Claude Code** — the CLI tool that acts as chief-of-staff

### 1. Initialize the Repo
Run `/init` in Claude Code. This populates CLAUDE.md, creates 1:1 and meeting folders, and seeds the style guide.

### 2. Overdue Task Notifications (Daily, 8 AM)
Installs a macOS launchd agent that checks for overdue tasks and pushes them to your phone via Apple Reminders.
```bash
bash bin/reminders/overdue-notifier-setup.sh install     # Enable (daily at 8 AM)
bash bin/reminders/overdue-notifier-setup.sh status       # Verify it's running
bash bin/reminders/overdue-notifier.sh --dry-run          # Test without creating reminders
NOTIFIER_HOUR=9 bash bin/reminders/overdue-notifier-setup.sh install  # Change time
```

### 3. Weekly Review Automation (Friday, 8 PM)
Installs a macOS launchd agent that runs Claude Code CLI every Friday at 8 PM with the `/weekly-review` command. Runs task triage, project health check, session compaction, and persists output.
```bash
bash bin/weekly-review/weekly-review-setup.sh install     # Enable (Fridays at 8 PM)
bash bin/weekly-review/weekly-review-setup.sh status       # Verify it's running
bash bin/weekly-review/weekly-review-runner.sh             # Test run now
REVIEW_HOUR=19 bash bin/weekly-review/weekly-review-setup.sh install  # Change time
```
Output is saved to `data/files/areas/weekly-reviews/sessions/YYYY-MM-DD.md`.

### 4. Morning Briefing Automation (Daily, 7 AM)
Installs a macOS launchd agent that runs `/morning-briefing` daily and writes to `data/files/areas/daily-briefings/sessions/YYYY-MM-DD.md`.
```bash
bash bin/cos schedule install                             # Enable (daily at 7 AM)
bash bin/cos schedule status                              # Verify it's running
bash bin/cos schedule uninstall                           # Disable
bash bin/schedule/morning-briefing.sh                     # Test run now
```
The plist label is `com.chief-of-staff.morning-briefing` and logs to `data/logs/morning-briefing.{log,err}`.

### 5. Chief of Staff app (v2 Tauri)
```bash
cd v2/app
npm install
npm run tauri dev   # dev mode with hot reload
# or:
npm run tauri build # produces a signed .dmg
```
Opens as a native desktop app. WYSIWYG editor (Tiptap), tabbed workspace, native macOS chrome.

### 6. MCP Server Integrations (Optional)
Each integration requires a one-time setup. The system works without any of them — features degrade gracefully to local-only context.
- **Slack** — bidirectional search, read, send
- **Google Workspace** — Calendar, Sheets, Slides, Docs
- **Jira/Linear** — engineering work items
- **Observability** (Datadog, etc.) — incident context
