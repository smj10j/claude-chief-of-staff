# Chief of Staff UI

Manage the local web UI — a WYSIWYG markdown editor for browsing and editing work-agent content.

## Arguments

The argument string is: $ARGUMENTS

Parse as a single token. Valid values: `start` (default if empty/omitted), `stop`.

## Actions

### start (default)

1. Check if port 3737 is already in use:
   - If a server is already running there, just open the browser and report it's running
   - If something else is using the port, tell the user
2. Run `ui/start.sh` in the background (installs dependencies and builds on first run — may take 10-15 seconds the first time)
3. Wait for the server to be ready (check with `curl -s http://localhost:3737/ > /dev/null`)
4. Open `http://localhost:3737` in the browser
5. Report back to the user that the UI is running

### stop

1. Find any process listening on port 3737 (`lsof -ti:3737`)
2. If found, kill it and confirm to the user
3. If nothing is running, tell the user the server wasn't running

## What it is

- Tiptap-based rich text editor with markdown round-tripping
- Floating toolbar (select text for formatting options)
- Auto-saves changes (2s after edits, plus periodic saves)
- Sidebar navigation for all people, meetings, projects, areas, and reference files
- Task dashboard view
- Dark mode support (follows system preference)
- Cmd+click internal links to navigate between files

## Requirements

- Node.js (v18+)
- No other setup needed — `start.sh` handles npm install and build automatically
