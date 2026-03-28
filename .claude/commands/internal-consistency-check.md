# Consistency Check

Audit the local work-agent repo for internal inconsistencies. Fix anything found (with confirmation). This is a housekeeping tool — run it periodically or before an upstream review.

## Execution Strategy

**Delegate the entire audit phase to a single Agent.** Launch one Agent (subagent_type: "Explore") that runs all 8 checks below and returns a structured findings table.

**Critical: minimize tool calls.** Every tool call inside the agent prompts the user for approval. The agent MUST gather all data in 4-5 tool calls total, then do all comparison logic in-memory. Never use a tool call for something that can be derived from data already collected.

### Data gathering (exactly these calls, no more)

**Call 1 — Bash: full repo structure + task data in one shot**
```bash
echo "=== TREE ===" && find areas/ projects/ archive/ .claude/commands/ -type f -o -type d | sort && echo "=== ROOT_FILES ===" && ls *.md *.yaml 2>/dev/null && echo "=== TASK_LIST ===" && bash data/task-cli.sh list --format json 2>/dev/null && echo "=== TASK_RECURRING ===" && bash data/task-cli.sh recurring --format json 2>/dev/null
```

**Calls 2-6 — Read (in parallel): the 5 reference docs**
- `CLAUDE.md`
- `README.md`
- `areas/one-on-ones/README.md`
- `areas/meetings/README.md`
- `projects/INDEX.md`

**That's it. No more tool calls.** Do all 8 checks by comparing the data from these 6 calls. Do NOT read individual README files, session files, or folders one at a time. Infer existence from the tree output.

For check 7 (session file staleness / empty Raw Notes), use the tree output to identify candidates, then note them as "could not verify content without additional reads" rather than making extra tool calls. If there are 3 or fewer candidates worth checking, the agent MAY read them — but only if it can do so in a single parallel batch.

After the Agent returns, present the findings table and offer to fix.

## Checks

The Agent should run each check below using ONLY the data gathered above. Collect all findings, then return a summary table. Group findings by severity:
- **Error** — broken reference, missing required file, orphaned folder
- **Warning** — stale content, mismatched listing, missing optional file
- **Info** — suggestion or note (e.g., empty sessions folder)

---

### 1. People: CLAUDE.md vs. 1:1 folders

Compare the people listed in the **Key People** and **1:1 folder listing** in CLAUDE.md against the actual folders in `areas/one-on-ones/` (from tree output).

Check for:
- People listed in CLAUDE.md but missing a 1:1 folder (not all Key People need folders — only those in the explicit 1:1 folder listing)
- 1:1 folders that exist but aren't listed in CLAUDE.md
- People in the wrong relationship category (e.g., listed as peer but folder is under `direct-reports/`)
- Every person folder must have a `README.md` and a `sessions/` directory (verify from tree output)

### 2. Commands: CLAUDE.md vs. `.claude/commands/`

Compare the **Custom Commands** section of CLAUDE.md against the command files found in the tree output.

Check for:
- Command files that exist but aren't listed in CLAUDE.md
- Commands listed in CLAUDE.md that don't have a corresponding file
- Command descriptions in CLAUDE.md that look stale (e.g., name mismatch)

### 3. Meetings: CLAUDE.md + meetings README vs. folders

Compare the meetings listed in CLAUDE.md and `areas/meetings/README.md` against meeting folders in the tree output.

Check for:
- Meeting folders that exist but aren't listed in either CLAUDE.md or the meetings README
- Meetings listed but with no corresponding folder
- Meeting folders missing a `README.md`
- Inconsistencies between CLAUDE.md and the meetings README (different names, different attendees)

### 4. Projects: INDEX.md vs. folders

Compare `projects/INDEX.md` against project/archive folders in the tree output.

Check for:
- Active projects in INDEX.md that have no folder in `projects/`
- Project folders in `projects/` that aren't listed in INDEX.md
- Archived projects in INDEX.md that don't have a folder in `archive/`
- Archive folders that aren't listed in the Archived section of INDEX.md
- Active project folders missing a `README.md` (warning, not error — some projects are lightweight)

### 5. Root files referenced in CLAUDE.md

Using the tree output and root files listing, verify that files referenced in CLAUDE.md actually exist:
- `data/cos.db` (confirmed if task-cli commands returned data)
- `style-guide.md`
- `google-docs-style-guide.md`

Also flag any root-level `.md` or `.yaml` files that exist but aren't mentioned in CLAUDE.md (they may be orphaned or just undocumented).

### 6. Areas folder structure

Using the tree output, verify the expected `areas/` subdirectories exist and have proper structure:
- `areas/one-on-ones/` — must have README.md and subdirectories per relationship type
- `areas/meetings/` — must have README.md
- `areas/career/` — should exist
- `areas/comms/` — should exist
- `areas/daily-briefings/` — should have `sessions/` directory

Flag any unexpected subdirectories in `areas/` that aren't accounted for.

### 7. Session files sanity

Using the tree output, spot-check session files across 1:1s and meetings:
- Any session files that don't follow the `YYYY-MM-DD.md` naming pattern
- Any person folders where the most recent session is more than 60 days old (potentially stale relationship — info only)
- For empty `## Raw Notes` detection: only check if 3 or fewer candidate files are older than 7 days AND can be read in a single parallel batch. Otherwise skip this sub-check and note it was skipped.

### 8. README vs. CLAUDE.md consistency

Compare the repo's `README.md` against `CLAUDE.md` and the actual repo structure for high-level accuracy. The README is the external-facing description — it must not describe a system that no longer exists.

Check for:
- **Task storage description**: Does the README describe YAML files when the system uses SQLite? Or vice versa?
- **Node.js version**: Does the README say a different version than `.nvmrc` or CLAUDE.md?
- **Commands table**: Are commands listed in CLAUDE.md but missing from the README's commands table? (Not all need to be in the README, but core ones should be.)
- **File structure tree**: Does the README's file structure section list files that don't exist (e.g., `tasks.yaml`) or omit directories that do (e.g., `data/`)?
- **Feature descriptions**: Does the README describe capabilities the system doesn't have, or omit major features?

This check is about factual accuracy, not style. Only flag things that are objectively wrong or misleading.

---

## Output

Present findings in a summary table:

| # | Severity | Area | Finding | Suggested Fix |
|---|----------|------|---------|---------------|
| 1 | Error | People | Folder `areas/one-on-ones/xfn/foo` exists but isn't in CLAUDE.md | Add to CLAUDE.md or remove folder |
| 2 | Warning | Commands | `/consistency-check` not listed in Custom Commands | Add to CLAUDE.md |
| ... | ... | ... | ... | ... |

If there are no findings, say so.

Then ask: **"Want me to fix these? I can do all, or you can pick specific items by number."**

Apply fixes with confirmation. For CLAUDE.md edits, show a preview of what will change before applying.

## Rules
- Read files before editing — never guess at content.
- Don't change personal content (names, notes, session data). Only fix structural issues (missing files, mismatched listings, broken references).
- When adding entries to CLAUDE.md, match the existing formatting exactly.
- When creating missing README files, use a minimal scaffold — don't invent content. Use what's available in CLAUDE.md or INDEX.md for context.
- Be conservative with "Info" findings — only surface them if they're genuinely useful. Don't flood the table with noise.
