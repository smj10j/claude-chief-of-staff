# Initialization Prompt

When the user runs `/init`, read this file and execute the onboarding flow below. Guide them through each phase interactively — ask questions, wait for answers, then build the system.

Do NOT rush through this. Each phase should feel like a conversation, not a form. Ask follow-up questions when answers are ambiguous. Confirm before creating files.

---

## Phase 1: Identity & Org

Ask:
- What's your name and title?
- What company/org are you at?
- What teams do you manage or lead? (name, focus area, size if known)
- What's your timezone?

**Actions:**
- Update CLAUDE.md `## Role` section
- Update CLAUDE.md `## Teams` section
- Store timezone in auto-memory MEMORY.md

---

## Phase 2: People Map

Walk through each relationship type. For each person, capture: name, role/title, team, meeting cadence, and anything top-of-mind.

Ask:
- "Who's your manager?" → create `areas/one-on-ones/manager/<name>/README.md`
- "Who are your direct reports?" → create folders under `areas/one-on-ones/direct-reports/<name>/`
- "Any peers you meet with regularly?" → create under `areas/one-on-ones/peers/<name>/`
- "Any skip-level relationships — people above your manager you meet with?" → create under `areas/one-on-ones/skip-level/<name>/`
- "Do you do skip-level 1:1s with your reports' reports?" → create under `areas/one-on-ones/skip-level-reports/<name>/`
- "Any cross-functional partners you meet with regularly?" → create under `areas/one-on-ones/xfn/<name>/`

For each person, create a README.md with:
```markdown
# [Name] — 1:1 Notes

## Context
- **Role:** [their role]
- **Team:** [their team]
- **Reports to:** [if known]
- **Cadence:** [weekly, biweekly, etc.]

## What's Top of Mind
<!-- What are they currently focused on? Any known concerns or goals? -->

## Working Style
<!-- How do they prefer to communicate? What motivates them? -->

## Standing Questions
<!-- Questions to keep in rotation across sessions -->
```

Also create an empty `sessions/` directory for each person.

**Actions:**
- Update CLAUDE.md `## Key People` section with the full map
- Update `areas/one-on-ones/README.md` with the folder structure listing
- Create all person folders with README.md + sessions/

---

## Phase 3: Recurring Meetings

Ask:
- "What recurring meetings do you attend that aren't 1:1s? Think team syncs, leadership meetings, reviews, standups."
- For each: name, cadence, who attends, shared doc link (if any), what you typically bring

**Actions:**
- Create folders under `areas/meetings/<meeting-id>/` with README.md
- Update `areas/meetings/README.md` with the meeting table

---

## Phase 4: Current State

Ask:
- "Any active projects right now — things with a finish line that you're tracking?"
  - For each: name, short description, status, target date
- "Any tasks top of mind — things you need to do this week or soon?"
- "Anything you're waiting on from someone else?"
- "Any recurring tasks — things you do daily or weekly that never finish?"

**Actions:**
- Create `projects/<id>/README.md` for each project
- Update `projects/INDEX.md` with project entries
- Seed `tasks.yaml` with captured tasks
- Seed `recurring.yaml` with recurring items
- Seed `waiting-for.md` with delegated items

---

## Phase 5: Style Calibration

Ask:
- "I'd like to learn your writing style so I can draft messages in your voice. Can you paste 3-5 recent Slack messages or emails you've written? Pick ones that feel like 'you' — could be announcements, replies, shout-outs, whatever."

**Actions:**
- Analyze the messages for patterns: tone, greeting style, structure, vocabulary, what they avoid
- Populate `style-guide.md` with observed patterns organized into sections (Voice, Tone Patterns, Structure, What to Avoid, etc.)
- This is a starting point — the guide evolves as the user gives feedback on future drafts

If they'd rather skip this step:
- That's fine. Leave style-guide.md with just the section headers. It'll fill in naturally over time as they edit drafts.

---

## Phase 6: Integrations (Optional)

Ask:
- "Do you have any MCP servers configured in Claude Code? For example: Slack search (Glean), Notion, Jira, Datadog, etc."
- "Would you like to configure any? I can help you set them up, or we can skip this and add them later."

**Actions:**
- Update CLAUDE.md `## Integrations` section with what's available
- Note which features benefit from each integration (e.g., "Slack search enables richer 1:1 prep")

---

## Wrap-up

After all phases:
1. Commit the initial state: `git add -A && git commit -m "Initial setup via /init"`
2. Print a summary of what was created (people, meetings, projects, tasks)
3. Suggest next steps:
   - "Try 'what's on my list today?' to see your tasks"
   - "Try 'prep for my 1:1 with [name]' before your next meeting"
   - "Try 'add a task: [description]' to capture something new"
   - "Try 'draft a message to my team about [topic]' to test the comms workflow"
