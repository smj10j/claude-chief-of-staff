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
Custom slash commands live in `.claude/commands/`. Invoke with `/command-name`.
- `/init` — Interactive onboarding: populates CLAUDE.md, creates 1:1 and meeting folders, seeds style guide
- `/morning-briefing` — Prioritized daily briefing: calendar, tasks, 1:1 prep, signals, project milestones
- `/weekly-review` — Friday GTD review: archive done tasks, triage overdue, check project health, preview next week
- `/prep-1on1 [name]` — Full 1:1 prep workflow: reads README + last session, gathers context, generates session file
- `/task-triage` — Surface overdue/stale tasks, recommend actions (re-date, drop, delegate), execute after confirmation
- `/review-launch-tracker` — Review a launch tracker spreadsheet: flag unapproved items, missing artifacts, stale dates, and missing launches
- `/ui` — Start the Chief of Staff web UI (WYSIWYG markdown editor at localhost:3737)
- `/publish-to-gdoc` — Render a markdown file into a formatted Google Doc for mobile reading. Optionally pass a doc URL to update in-place.
- `/process-ui-annotations [file]` — Process annotations left in the Chief of Staff UI. Reads highlighted text + instructions, applies changes, clears annotations. Triggered by the "Process with Claude" button in the UI, or run manually from terminal.
- `/review-reminders` — Import pending items from Apple Reminders into the task database. Reads from a configured list, lets you selectively import with tag/date enrichment.
- `/task-export` — Export the task database to YAML files for backup or debugging
- `/internal-consistency-check` — Audit repo for internal inconsistencies: missing READMEs, mismatched listings, orphaned folders, stale sessions
- `/upstream-review` — Diff personal instance against the template repo, identify generalizable changes, and open a PR

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
  - `bin/reminders/` - Apple Reminders adapter (Swift/EventKit). `apple-reminders.sh` wrapper auto-compiles `apple-reminders.swift` on first run.
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
        - Organized by relationship type: `direct-reports/`, `manager/`, `peers/`, `skip-level/`, `skip-level-reports/`, `xfn/`
        - **Session workflow defined in `data/files/areas/one-on-ones/README.md`** — follow this for all prep and digest steps
        - Before a 1:1: read README + last session, generate session doc with empty `## Raw Notes` section. After: digest raw notes, read shared doc if available via integration, update README, update tasks, propose new AIs
        - Every session file MUST start with a `## Shared Agenda` section at the top — a compressed, copy/paste-ready list that can be dropped directly into a shared doc. Each item should be a question or a topic to check in on. Keep it tight — no background context unless absolutely necessary. The full prep (context, coaching notes, research) goes in the sections below. This shared agenda serves three purposes: (1) gives the other person context before the meeting, (2) structures the live conversation, (3) makes it easy for Claude to read the doc afterward and capture outcomes.
      - `data/files/areas/meetings/` - recurring meetings and forums (not 1:1s). Same pattern: `README.md` (persistent context, attendees, standing agenda) + `sessions/` (dated prep/notes)
        - Before a meeting: read README + last session. After: create session file. Periodically: update README
      - `data/files/areas/career/` - promotion tracking, growth plans, strategic relationships
      - `data/files/areas/comms/` - drafted messages and comms
      - `data/files/areas/daily-briefings/` - daily morning briefing history. Same `sessions/YYYY-MM-DD.md` pattern. Auto-written by `/morning-briefing`.
    - `data/files/archive/` - completed projects moved from `data/files/projects/`. Not deleted — kept for reference.
- `cos-dev/` - Chief of Staff development documentation
  - `cos-dev/SECURITY.md` - Threat model, current controls, security checklist
  - `cos-dev/implementation-loop.md` - Process for implementing PRDs (follow this when building features)
  - `cos-dev/PRDs/` - Product requirement documents for UI features
    - `cos-dev/PRDs/INDEX.md` - PRD registry (status, dates, links). Always update this when creating or completing a PRD.
  - `cos-dev/implementations/` - Implementation trackers for completed PRDs (audit trail, soak logs, cleanup checklists)

### Project Lifecycle
1. **Start**: create `data/files/projects/<id>/` folder, add row to `data/files/projects/INDEX.md`
2. **Complete**: mark done in INDEX.md with completion date, move folder to `data/files/archive/`
3. **Areas** never complete — they persist in `data/files/areas/` indefinitely

### Chief of Staff UI
- Local web UI at `http://localhost:3737` — WYSIWYG markdown editor powered by Tiptap
- Start with `/ui` command. First run installs Node dependencies and builds automatically (requires Node.js 22+)
- Source lives in `ui/` directory: `src/` (ES modules), `build.js` (esbuild bundler), `server.js` (Express), `start.sh` (launcher)
- Edits in the UI auto-save back to the markdown files on disk. Changes from Claude or the filesystem trigger a live reload in the browser via SSE.

## Daily Briefing

When asked "what's on my list today?", "what should I prioritize?", or similar — run the `/morning-briefing` command. It handles calendar, tasks, 1:1/meeting prep, signals, and writes a dated briefing file.

## 1:1 Prep

When asked to prep for a 1:1, run `/prep-1on1 [name]`. The full prep workflow, relationship type guidance, and session template are defined in `data/files/areas/one-on-ones/README.md`.
