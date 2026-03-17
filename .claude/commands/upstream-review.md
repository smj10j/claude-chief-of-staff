# Upstream Review

Review changes in this personal instance and identify what can be generalized back to the template repository.

**Upstream repo:** <!-- Your upstream repo URL, e.g. https://github.com/youruser/claude-chief-of-staff.git -->
**Personal instance:** this repo

## Steps

### 0. Set Up Local Access to Upstream

Check if a local clone of the upstream repo exists. Search common locations:
- Sibling directories (e.g., `../claude-chief-of-staff`)
- Home code directories (e.g., `~/code/claude-chief-of-staff`)

If found, use it. If not found:
- Clone the upstream repo to a temporary location: `git clone <upstream-url> /tmp/claude-chief-of-staff`
- Use the clone for diffing and as the target for changes

Store the resolved path as `$UPSTREAM` for the rest of the workflow.

### 1. Internal Consistency Check

Before comparing to upstream, audit the local repo for internal inconsistencies. Check:

- **CLAUDE.md people list vs. 1:1 folder structure** — does the people listing in CLAUDE.md match the actual folders in `areas/one-on-ones/`? Are relationship categories correct (direct-reports, skip-level-reports, peers, etc.)?
- **CLAUDE.md commands list vs. actual commands** — does every file in `.claude/commands/` appear in the Custom Commands section?
- **CLAUDE.md meetings list vs. meetings folders** — does the meetings listing match `areas/meetings/`?
- **README.md vs. actual file structure** — does the file structure section reflect what actually exists?
- **Stale GTD files** — are `someday-maybe.md`, `waiting-for.md` current? Are there completed items that should be cleared or files that should be deleted?
- **Projects INDEX.md vs. project folders** — do all active projects in the index have folders? Are there orphaned project folders?

Present any inconsistencies found and fix them (with confirmation) before proceeding to the upstream diff. This keeps the repo clean before sharing changes externally.

### 2. Diff the Repos

Compare key files between this repo and `$UPSTREAM`. Focus on structural and workflow files, not personal content. Check these categories:

**System files** (likely generalizable):
- `CLAUDE.md` — compare the "System Conventions" section (below the `---` separator). Ignore the personal context section above it.
- `.claude/commands/` — any commands here that don't exist upstream
- `README.md` — structural/documentation changes
- `areas/one-on-ones/README.md` — 1:1 workflow docs
- `areas/meetings/README.md` — meeting workflow docs
- `areas/career/README.md` — career tracking scaffold
- `style-guide.md` — structural changes (not personal content)
- Root-level YAML files (`tasks.yaml`, `tasks-archive.yaml`, `recurring.yaml`) — schema changes only
- `projects/INDEX.md` — template structure changes only
- `.gitignore` — any additions

**Personal files** (never upstream):
- Anything in `areas/one-on-ones/<person>/` (actual 1:1 data)
- Anything in `areas/meetings/<meeting>/sessions/` (actual meeting notes)
- Task content in YAML files
- `areas/career/` personal content
- `areas/comms/` drafts
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
- Don't over-templatize. If a command references `tasks.yaml` or `areas/one-on-ones/`, that's system structure — keep it. Only templatize things like specific names, teams, and channels.
- When porting commands, replace first-person name references with "you" or remove them. The CLAUDE.md personal context section will have the user's name — commands don't need to hardcode it.
- Always work on a branch and offer a PR. Never push directly to main.
