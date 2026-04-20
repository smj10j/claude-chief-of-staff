#!/bin/bash
# weekly-review-runner.sh — Run the weekly review via Claude Code CLI.
# Called by launchd agent every Friday at 8 PM.
#
# Invokes Claude Code in non-interactive mode with the /weekly-review prompt.
# Output is captured by launchd's StandardOutPath/StandardErrorPath.

set -euo pipefail

COS_DIR="${COS_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$COS_DIR"

# Find the claude binary
find_claude() {
    # Check common locations
    for candidate in \
        "$HOME/.claude/local/claude" \
        "$HOME/.local/bin/claude" \
        "/usr/local/bin/claude" \
        "/opt/homebrew/bin/claude" \
        "$(command -v claude 2>/dev/null || true)"; do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

CLAUDE_BIN=$(find_claude) || {
    echo "ERROR: Could not find claude binary. Ensure Claude Code is installed and on PATH."
    exit 1
}

echo "$(date '+%Y-%m-%d %H:%M:%S') Starting weekly review..."
echo "  Claude: $CLAUDE_BIN"
echo "  Working dir: $COS_DIR"

PROMPT="Run /weekly-review in unattended mode. This is an automated Friday evening run.

Rules for unattended execution:
- Auto-resolve safe items during task triage and session compaction (follow-ups found in task DB, factual README updates)
- For session compaction: compact all verified candidates without asking for confirmation
- For undigested sessions: skip them (don't compact, note in report)
- For orphaned action items: note them in the report but don't block compaction of other files
- Persist the full weekly review output to data/files/areas/weekly-reviews/sessions/
- Commit all changes
- Do NOT send any Slack messages or external communications"

"$CLAUDE_BIN" -p "$PROMPT" --allowedTools 'Bash(read-only commands, task CLI, git operations)' 'Read' 'Write' 'Edit' 'Glob' 'Grep' 2>&1

EXIT_CODE=$?
echo "$(date '+%Y-%m-%d %H:%M:%S') Weekly review finished with exit code $EXIT_CODE"
exit $EXIT_CODE
