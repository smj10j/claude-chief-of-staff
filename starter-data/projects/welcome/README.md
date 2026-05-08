# Welcome to Chief of Staff

This is a starter project to walk you through what the app can do. Work through the items below at your own pace — they're written as a guided tour, but each one is self-contained so you can skip ahead.

## What this app is for

Chief of Staff is a personal productivity system pairing a markdown + SQLite data tree with Claude as an always-present collaborator. The big idea: you keep your notes in plain files on your laptop, and an AI chief of staff handles the busywork on top of them — drafting 1:1 prep, digesting meetings, generating morning briefings, triaging tasks, surfacing ops signals.

Think of it as a Notion + Slack-bot + project-manager rolled into one, with no servers, no accounts, and your data in folders you can grep through.

## Things to try, in rough order

### 1. Generate a 1:1 prep doc — the moment the app earns its keep

If you set up direct reports during onboarding (or you just added a person folder under `areas/one-on-ones/direct-reports/`), open the **People** sidebar entry, click that person, and press the **"Prep 1:1"** button.

Claude reads their README + the last few sessions, gathers any Slack signal it can find, and drafts a "shared agenda" you can paste into a Google Doc before the meeting. The doc lives at `areas/one-on-ones/<relationship>/<slug>/sessions/YYYY-MM-DD.md`.

After your next 1:1, click **"Digest"** to capture notes — Claude reads your raw notes + the shared doc, structures the session, updates the README with new themes, and proposes follow-up tasks.

### 2. Run a morning briefing

On **Home**, hit **"Brief me"**. Claude pulls your calendar, today's tasks, recent Slack signals, and active project notes into a written briefing. Takes 3-10 minutes — you can keep working in another tab while it runs.

You can also schedule it to run automatically every morning. See `bin/weekly-review/weekly-review-setup.sh` for the launchd-agent recipe.

### 3. Capture and triage tasks

Cmd+N anywhere → quick task capture. Tasks land in the **Tasks** surface, bucketed by due date.

When the list feels heavy, hit **"Triage"** — Claude reviews overdue + stale items and suggests actions (re-date, drop, delegate). You confirm before anything changes.

Tasks can be tagged with a project (`work`, `team:dder-mx`, `xfn`, etc.) and link to other docs by relative path.

### 4. Annotate a markdown file → have Claude apply your edits

Open any markdown file in the editor. Highlight a section, click the pencil icon in the floating toolbar, and type an instruction ("rewrite this for the board," "expand with more detail," "research and fill in," etc.).

The annotation persists immediately. Click **"Process with Claude"** in the header — Claude reads each annotation, applies the change, and clears the annotation. You can also trigger from terminal: `claude /process-ui-annotations <file-path>`.

This is the two-way collaboration surface — you mark up the document, Claude carries out the changes asynchronously, and you review the diff.

### 5. Try the tabbed workspace

The app uses a Chrome-style tab strip. Cmd+T opens a new tab, Cmd+W closes, Cmd+1..9 jumps to a specific tab, Cmd+Shift+T reopens the last closed. Drag to reorder; right-click a tab for the action menu (pin, rename, duplicate, close-others, close-to-the-right).

Each tab has its own navigation context — one for an active 1:1, one for tasks, one for a strategy doc, all running concurrently.

### 6. Edit the style guide

Open `style-guide.md` (lives at the root of your data folder). Right now it's mostly placeholders. As you use the app and edit Claude's drafts, the file accumulates lessons learned — Claude consults it before writing anything on your behalf.

The fastest way to fill it in: edit a draft Claude generated, then ask Claude to update the style guide with what changed. Over a few weeks the file matches your voice closely.

### 7. Plug in the integrations

Open **Settings**. Each integration (Slack, Google Workspace, Glean, Atlassian/Jira, Datadog, Rollbar, GitHub) is set up via a Claude Code MCP server. Most authenticate via OAuth on first use — when you run a skill that needs them, your browser opens to sign in. No manual config files.

The integrations make the assistant *radically* more useful — `/prep-1on1` surfacing Slack signal, `/morning-briefing` pulling Jira + GitHub status, `/task-triage` cross-referencing your calendar — but the app works without them too. Add them as you go.

### 8. Power-user stuff

- **Cmd+K**: command palette. Fuzzy search across files, people, tasks, projects, and slash commands.
- **Cmd+,**: Settings.
- **Cmd+/**: keyboard shortcut cheatsheet.
- **Cmd+\\**: toggle the right side panel (task detail, etc.).
- **Cmd+Shift+B**: toggle the sidebar.
- **Slash commands**: every UI button is also a CLI slash command (`/prep-1on1`, `/morning-briefing`, `/task-triage`). Run them from Claude Code in your terminal when you want to script something.

### 9. Make it yours

The project structure is a starting point, not a template you have to follow. If a folder pattern doesn't work for you, restructure it — the app reads the filesystem, no schema enforced. Add areas, drop the ones you don't use, write your own slash commands under `.claude/commands/`.

The whole system is meant to feel like *your* notes that an AI happens to be good at navigating, not someone else's framework you're conforming to.

## When you're ready

Mark this project complete (drag it to archive) when you've worked through whatever pieces felt useful. Or leave it here as a reference — there's no penalty for keeping it around.

If something's broken or feels confusing, check `cos-dev/PRDs/v2/` for the design intent, or open an issue. Most surfaces have a "Diagnostics" panel in Settings that surfaces the relevant config + logs.

Welcome aboard.
