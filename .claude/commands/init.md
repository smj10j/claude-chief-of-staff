# Initialize Work Agent

Interactive onboarding to personalize this system for a new user. Walk through each section conversationally — ask questions, confirm before writing.

## Steps

### 1. Personal Context

Ask the user about their role and populate the personal context section of CLAUDE.md (everything below the `---` separator). Gather:

- **Role**: title, company, org
- **Teams**: what teams they manage or are part of
- **Key People**: manager, direct reports, peers, skip-levels, key XFN partners. For each, capture name, role, and relationship context
- **Comms Style**: how they like to communicate (ask for a few example Slack messages if possible, or ask about tone/voice preferences)
- **Preferences**: GTD familiarity, what they want to offload, any strong opinions about how Claude should behave

### 2. 1:1 System

For each person identified in Key People who has regular 1:1s:
1. Determine the relationship category (direct-report, manager, peer, skip-level, skip-level-report, xfn)
2. Create the folder: `areas/one-on-ones/<category>/<name>/`
3. Create a starter `README.md` with role, team, and any context the user shared
4. Create an empty `sessions/` directory (add a `.gitkeep`)

Update `areas/one-on-ones/README.md` with the folder structure listing.

### 3. Meetings

Ask about recurring meetings (not 1:1s) — team syncs, leadership forums, reviews. For each:
1. Create `areas/meetings/<meeting-id>/README.md` with cadence, attendees, shared doc link if any
2. Create an empty `sessions/` directory

Update `areas/meetings/README.md` with the meeting listing.

### 4. Projects

Ask about any active projects or initiatives. For each:
1. Create `projects/<id>/README.md` with a brief description
2. Add a row to `projects/INDEX.md`

### 5. Integrations

Ask what tools they use and configure the integrations section of CLAUDE.md:
- Slack (via Glean MCP, or direct)
- Calendar (google-workspace MCP)
- Jira/Linear
- Notion
- Other MCP servers

### 6. Style Guide

If the user provided example messages in step 1, use them to seed `style-guide.md`. Otherwise, explain that the style guide will build up over time as they edit Claude's drafts.

### 7. Git Setup

- Run `git add -A && git status` to show what was created
- Offer to make an initial commit

### 8. Next Steps

After the commit, mention these as things they can try right away:
- `/ui` — Opens a web-based editor for browsing and editing files visually (like Google Docs). Requires Node.js 18+. First run installs automatically.
- `/morning-briefing` — Get a prioritized daily briefing
- "Add a task: [something]" — Start capturing work

Don't run `/ui` automatically — just let them know it exists. Keep this brief (2-3 lines).

## Rules

- Be conversational, not interrogative. This should feel like onboarding with a smart colleague, not filling out a form.
- Confirm the CLAUDE.md content before writing it — show a preview.
- Don't overwhelm. If the user doesn't have answers for everything, skip it and note it can be filled in later.
- Keep the system section of CLAUDE.md (above the `---`) intact — only populate the personal section below it.
- Use the existing file templates and conventions already in the repo.
