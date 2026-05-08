# Compact Sessions

Compact old session files across 1:1s, meetings, and daily briefings. Archives originals, then consolidates all compact summaries for a person/area into a single file. Preserves all information.

## Parameters

- `$ARGUMENTS` — optional:
  - A person or meeting name to compact only that folder (e.g., `alice`, `xfn-weekly-sync`)
  - `--dry-run` to preview candidates without making changes
  - `--all` to process everything (default if no args)

## Compaction Rules

### Hot Window (never compact)
- **1:1s and meetings:** Last 3 sessions per person/meeting
- **Daily briefings:** Sessions from the last 14 days
- **Any session dated today or in the future**

### What Gets Compacted
- Sessions outside the hot window that don't already have an archived original in `sessions/archive/`
- Sessions that have been digested (have `## Session Notes` or `## Digest` section)
- Undigested sessions (only `## Raw Notes` + `## Prep`) are flagged, NOT auto-compacted

### Output Format

All compact summaries for a person/area are consolidated into a **single file** per `sessions/` directory:

```
sessions/compacted_2026-03-11_to_2026-04-13.md   ← one file with all compacted sessions
sessions/2026-04-14.md                            ← hot (full fidelity)
sessions/2026-04-16.md                            ← hot (full fidelity)
sessions/2026-04-20.md                            ← hot (full fidelity)
sessions/archive/                                 ← originals of every compacted session
```

The consolidated file uses **H2 per session** (date as heading), with H3 for subsections. Sessions are ordered **most recent first** (reverse chronological). A `---` separates each session.

### Compact Summary Formats

**1:1s with direct reports and skip-level reports** (20-30 lines per session):
Determine by folder path: `one-on-ones/direct-reports/*` or `one-on-ones/skip-level-reports/*`

```markdown
## 2026-03-16

**Original:** archive/2026-03-16.md

### Key Outcomes
- [3-5 bullets: decisions, status changes, answers gotten]

### Coaching & Growth Signals
- [Qualitative: tone, energy, confidence, ownership patterns]
- [Coaching feedback given and how it landed]
- [Growth trajectory signals]

### Follow-ups (at time of session)
- [Owner]: [item] - STATUS: [in task DB / carried in next session / dropped]

### Context Threads
- [Topic]: [One-line state as of this session]
```

**1:1s with manager, peers, skip-level, XFN** (15-20 lines per session):

```markdown
## 2026-03-18

**Original:** archive/2026-03-18.md

### Key Outcomes
- [3-5 bullets]

### Relationship & Strategic Notes
- [Rapport, dynamics, commitments, political context, alignment signals]

### Follow-ups (at time of session)
- [Owner]: [item] - STATUS: [in task DB / carried / dropped]

### Context Threads
- [Topic]: [One-line state]
```

**Meetings** (15-20 lines per session):

```markdown
## 2026-03-12

**Original:** archive/2026-03-12.md

### Decisions & Outcomes
- [Bullets: decisions made, status changes]

### Action Items (at time of session)
- [Owner]: [item] - STATUS: [resolved / carried / dropped]

### Notable
- [Anything surprising, contentious, or worth remembering]
```

**Daily briefings** (10-15 lines per session):

```markdown
## 2026-03-25

**Original:** archive/2026-03-25.md

### Top Priorities That Day
- [3-5 items flagged as focus]

### Signals Flagged
- [Slack/comms items surfaced]

### Outcomes
- [What happened, if known from subsequent sessions]
```

### Consolidated File Structure

The H1 header identifies the person/meeting and date range:

```markdown
# Compacted Sessions: [Name] - 2026-03-11 to 2026-04-13

## 2026-04-13 (undigested)
**Original:** archive/2026-04-13.md
### Prep Topics
- ...

---

## 2026-03-25
**Original:** archive/2026-03-25.md
### Key Outcomes
- ...
### Coaching & Growth Signals
- ...

---

## 2026-03-11 (prep-only)
**Original:** archive/2026-03-11.md
### Prep Topics
- ...
```

## Verification Checklist

Before compacting any session, verify ALL of the following:

1. **Not in hot window** — at least 3 newer sessions exist (or >14 days old for briefings)
2. **Session was digested** — has `## Session Notes` or `## Digest`, NOT just `## Raw Notes` + `## Prep`. Flag undigested sessions and ask: digest now, compact with warning, or skip?
3. **Follow-ups accounted for** — every checkboxed action item must be:
   - Present in the task database (search by keyword, person name, project), OR
   - Referenced in a subsequent session (carried forward), OR
   - Explicitly marked as dropped
   - If not found anywhere: it's an **orphan**. Flag it and do NOT compact until resolved.
   - Search task DB with multiple strategies: keywords from the item, person name, project name. Include search terms tried when flagging potential orphans.
4. **README reflects durable context** — role changes, personnel moves, project shifts are in the person/meeting README. If not, update README BEFORE compacting.
5. **Coaching signals preserved (direct reports + skip-level reports only)** — extract qualitative observations into the compact summary's Coaching & Growth Signals section. Cross-check against career development docs.
6. **Date is strictly before today**

## Execution Steps

### Step 1: Discover Candidates

Scan all session locations:
- `data/files/areas/one-on-ones/**/sessions/`
- `data/files/areas/meetings/*/sessions/`
- `data/files/areas/daily-briefings/sessions/`

For each directory:
- List all `.md` files (excluding `compacted_*.md`), sorted by date descending
- Apply hot window rules to identify candidates
- Skip files that already have a corresponding file in `sessions/archive/`
- Note whether a `compacted_*.md` file already exists (will be regenerated with expanded range)

Present summary:
| Folder | Total Sessions | Hot (keep) | Candidates | Already Archived | Existing Compacted File |

**If `--dry-run`:** Stop after presenting the summary table.

### Step 2: Verify Candidates

Process one person/meeting at a time:
1. Read the person/meeting README once
2. Read each candidate session
3. Check digestion status (Session Notes vs Raw Notes)
4. Extract follow-up items, search task DB for each
5. Extract coaching signals (direct reports only)
6. Check README for durable context gaps

Present findings:
| File | Digested? | Orphaned Items | README Gaps | Ready? |

### Step 3: Resolve Issues

For files NOT ready:
- **Undigested:** Ask "Digest now, compact with warning, or skip?"
- **Orphaned items:** Present each. Ask "Add to task DB, mark as dropped, or skip this file?"
- **README gaps:** Show what's missing. Ask "Update README, or skip?"

When running inside `/weekly-review`, batch all confirmations into one prompt (not per-file). Present the full list with recommended actions and ask for blanket approval with exceptions.

### Step 4: Execute Compaction

Process one person/meeting at a time:

1. Read all candidate session files for this person/meeting into memory
2. Copy each original to `sessions/archive/YYYY-MM-DD.md` (create `archive/` dir if needed)
3. Verify each archive copy exists and is non-empty
4. Generate a compact summary for each session (following the format templates above)
5. If an existing `compacted_*.md` file exists, read it and incorporate its existing sections
6. Write the consolidated file to `sessions/compacted_STARTDATE_to_ENDDATE.md` where STARTDATE is the earliest compacted session and ENDDATE is the latest
7. Verify the consolidated file exists and is non-empty
8. Delete the individual session files that were compacted (NOT the archive copies)
9. If a previous `compacted_*.md` file existed with a different date range, delete it (its content was merged into the new file)

**File naming:** `compacted_YYYY-MM-DD_to_YYYY-MM-DD.md` — underscores to avoid ambiguity with date hyphens.

**After compaction, the sessions/ directory should contain:**
- Hot (full-fidelity) session files: `YYYY-MM-DD.md`
- One consolidated compact file: `compacted_STARTDATE_to_ENDDATE.md`
- `archive/` directory with all originals

### Step 5: Report

Generate a compaction report:

```markdown
## Compaction Report - YYYY-MM-DD

### Summary
- Files scanned: N
- Files compacted: N
- Files skipped (hot window): N
- Files skipped (undigested): N
- Files skipped (user chose to skip): N
- Orphaned items found: N (resolved: N, deferred: N)
- README updates made: N

### Details
| Person/Meeting | File | Action | Notes |
|---|---|---|---|
```

Commit: `chore: compact N session files, archive originals`

## Rules
- NEVER delete original files. Always archive first.
- NEVER compact undigested sessions without explicit user choice.
- NEVER compact sessions with orphaned action items without resolution.
- Process one person/meeting at a time for coherent context.
- Write archive copies FIRST, then build the consolidated file, then delete individual compact files. If interrupted, originals are safe in archive.
- The consolidated file (`compacted_*.md`) is the single source of compacted history per person/area. Individual per-session compact files should NOT exist alongside it.
