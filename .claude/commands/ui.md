# Chief of Staff UI

Manage the local web UI — a WYSIWYG markdown editor for browsing and editing work-agent content.

## Arguments

The argument string is: $ARGUMENTS

Parse as a single token. Valid values: `start` (default if empty/omitted), `stop`.

## How to run

The start script (`ui/start.sh`) handles everything: port checks, dependency installation, building, starting the server, waiting for readiness, and opening the browser. Do NOT reimplement any of this logic manually.

- **start** (default): Run `bash ui/start.sh` and report the output to the user.
- **stop**: Run `bash ui/start.sh stop` and report the output to the user.

That's it. Just run the script and relay what it says.

## What it is

- Tiptap-based rich text editor with markdown round-tripping
- Floating toolbar (select text for formatting options)
- Auto-saves changes (2s after edits, plus periodic saves)
- Sidebar navigation for all people, meetings, projects, areas, and reference files
- Task dashboard view
- Dark mode support (follows system preference)
- Cmd+click internal links to navigate between files

## Requirements

- Node.js (v22+)
- No other setup needed — `start.sh` handles npm install and build automatically
