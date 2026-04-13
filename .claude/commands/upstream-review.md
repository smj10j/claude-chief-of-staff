# Upstream Review

Review changes in this personal instance and identify what can be generalized back to the template repository.

**Upstream repo:** `https://github.com/smj10j/claude-chief-of-staff.git`
**Personal instance:** this repo

## Execution Strategy

**Run the internal consistency check first, then delegate the diff/classify work to an Agent.**

1. **Step 1 first (serial):** Run `/internal-consistency-check` in the main conversation. Fix any findings before proceeding. This ensures the repo is clean and consistent before diffing against upstream — otherwise the consistency fixes would show up as upstream-portable changes when they're really just local housekeeping.
2. **Steps 0, 2-4 (delegated):** After consistency fixes are applied, launch one Agent that:
   - Locates or clones the upstream repo
   - Diffs all key files between this repo and upstream
   - Classifies each change as Generalizable / Personal / Needs Templatizing
   - Returns the structured findings table from Step 4
3. **Steps 5-6 (main conversation):** Present findings and proceed with execution and summary — these need user confirmation and write access.

## Steps

### 0. Set Up Local Access to Upstream

Check if a local clone of the upstream repo exists. Search common locations:
- Sibling directories (e.g., `../claude-chief-of-staff`)
- Home code directories (e.g., `~/code/claude-chief-of-staff`)

If found, use it. If not found:
- Clone the upstream repo to a temporary location: `git clone https://github.com/smj10j/claude-chief-of-staff.git /tmp/claude-chief-of-staff`
- Use the clone for diffing and as the target for changes

Store the resolved path as `$UPSTREAM` for the rest of the workflow.

### 1. Internal Consistency Check (serial — run before delegating)

Run `/internal-consistency-check` to audit the local repo for internal inconsistencies. **Fix all findings in the main conversation before launching the diff Agent.** This keeps the repo clean before sharing changes externally and prevents consistency fixes from polluting the upstream diff.

### 2. Diff the Repos

Run a **comprehensive diff** between this repo and `$UPSTREAM`. Do not cherry-pick files — diff everything and then classify. The reliable way to catch all changes is:

```bash
# From the personal repo root:
diff -rq . $UPSTREAM --exclude=node_modules --exclude=.git --exclude='*.db' --exclude='*.db-*' --exclude=bundle.js --exclude='bundle.js.map' --exclude=.annotations --exclude=cos-dev | grep -v 'Only in ./data/'
```

This surfaces every file that differs, including static assets (CSS, HTML), build scripts, and source files — not just markdown. Then classify each difference using the categories below:

**System files** (likely generalizable):
- `CLAUDE.md` — compare the "System Conventions" section (below the `---` separator). Ignore the personal context section above it.
- `.claude/commands/` — any commands here that don't exist upstream
- `README.md` — structural/documentation changes
- `data/files/areas/one-on-ones/README.md` — 1:1 workflow docs
- `data/files/areas/meetings/README.md` — meeting workflow docs
- `data/files/areas/career/README.md` — career tracking scaffold
- `data/files/style-guide.md` — structural changes (not personal content)
- `bin/db/` directory (task-db.js, task-cli.sh, task-cli.js, migrations) — schema and module changes only
- `data/files/projects/INDEX.md` — template structure changes only
- `.gitignore` — any additions

**Code files** (often generalizable — these are just as important as config/docs):
- `ui/start.sh` — server lifecycle management (nvm, start/stop, port checking)
- `ui/server.js` — API endpoints, task integration, server logic
- `ui/build.js` — client bundle build script
- `ui/src/*.js` — all frontend source files (editor, main, toolbar, search, annotations, tasks)
- `ui/public/` — HTML shell, CSS, static assets
- `bin/db/task-db.js` — shared data access module
- `bin/db/task-cli.js` — CLI implementation
- `bin/db/task-cli.sh` — nvm-aware shell wrapper
- `bin/db/migrations/` — SQL schema files
- `bin/db/tests/` — test suites

**Important:** Code improvements are just as portable as documentation changes. New API endpoints, UI features, editor enhancements, build script improvements, and test coverage all belong upstream. Don't limit the diff to just markdown and config files.

**Personal files** (never upstream):
- Anything in `data/files/` that contains user-specific content (1:1 sessions, meeting notes, task data, career notes, comms drafts)
- The `data/cos.db` database
- The personal context section of CLAUDE.md (Role, Teams, Key People, Comms Style, Preferences, Integrations)

### 3. Categorize Changes

For each difference found, classify it:

- **Generalizable** — A new feature, workflow improvement, or structural change that any user would benefit from. These should be ported upstream.
- **Personal** — Content specific to this user (names, teams, Slack channels, etc.). Skip these.
- **Needs Templatizing** — A generalizable change that contains personal details. These need the personal bits replaced with template placeholders (HTML comments, generic examples) before porting.

### 4. Present Findings

Show a summary table:

| Change | File(s) | Category | Action |
|--------|---------|----------|--------|
| New `/morning-briefing` command | `.claude/commands/morning-briefing.md` | Needs templatizing | Port with generic references |
| Added session workflow to CLAUDE.md | `CLAUDE.md` | Generalizable | Port as-is |
| ... | ... | ... | ... |

For each "Needs Templatizing" item, show what specifically needs to change (e.g., "Replace user's name with generic reference, remove specific Slack channel names").

### 5. Execute (with confirmation)

After confirming which changes to port:

1. **Create a branch** in `$UPSTREAM`: `git checkout -b upstream-review/YYYY-MM-DD`
2. For each approved change, create or update the file in the upstream repo
3. When templatizing:
   - Replace personal names with generic references or HTML comment examples
   - Replace specific team/channel names with placeholder examples
   - Keep the workflow logic and structure intact
   - Use the existing template style (HTML comments for examples, generic "you/your" language)
4. Show a diff preview of each file before writing
5. **Commit** the changes to the branch
6. **Offer to open a PR** against the upstream repo using `gh pr create` (if gh CLI is available and authenticated). If not available, provide the URL to create one manually.

### 6. Summary

Show what was ported, what was skipped, and any remaining items for next time.

## Rules
- NEVER copy personal content (names, tasks, session notes, career details) to the upstream repo.
- When in doubt about whether something is personal or generalizable, ask.
- Preserve the template's style — it uses HTML comments for examples and generic language.
- The template should work for any engineering manager/tech lead, not just the current user.
- Don't over-templatize. If a command references `bin/db/task-cli.sh` or `data/files/areas/one-on-ones/`, that's system structure — keep it. Only templatize things like specific names, teams, and channels.
- When porting commands, replace first-person name references with "you" or remove them. The CLAUDE.md personal context section will have the user's name — commands don't need to hardcode it.
- Always work on a branch and offer a PR. Never push directly to main.
