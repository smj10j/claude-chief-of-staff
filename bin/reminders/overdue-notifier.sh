#!/bin/bash
# overdue-notifier.sh — Check for overdue tasks and create Apple Reminders for them.
#
# Reads from the task database (read-only — never modifies tasks).
# Creates reminders in a dedicated Apple Reminders list so they show up as
# phone notifications. Tracks which tasks have already been notified to avoid
# duplicates across runs.
#
# Usage:
#   bash bin/reminders/overdue-notifier.sh          # Run once (cron/launchd calls this)
#   bash bin/reminders/overdue-notifier.sh --dry-run # Preview without creating reminders
#
# Configuration:
#   NOTIFIER_LIST  — Apple Reminders list to write to (default: "Overdue Tasks")
#   WORK_AGENT_DIR — Path to the work-agent repo (default: script's grandparent dir)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_AGENT_DIR="${WORK_AGENT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
REMINDERS_SH="$SCRIPT_DIR/apple-reminders.sh"
TASK_CLI="$WORK_AGENT_DIR/bin/db/task-cli.sh"
NOTIFIED_FILE="$WORK_AGENT_DIR/data/.overdue-notified"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
fi

# Ensure the notified-tracking file exists
touch "$NOTIFIED_FILE"

# Export the target list for the reminders adapter
export REMINDERS_ADD_LIST="${NOTIFIER_LIST:-New Tasks}"

# Source nvm for Node.js (task-cli needs it)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Get overdue tasks as JSON
OVERDUE_JSON=$("$TASK_CLI" list --due-by today --format json 2>/dev/null)

if [ -z "$OVERDUE_JSON" ] || [ "$OVERDUE_JSON" = "[]" ]; then
    exit 0
fi

# Process each overdue task
echo "$OVERDUE_JSON" | node -e "
const tasks = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
const now = new Date();
for (const t of tasks) {
    if (!t.isOverdue && t.due && !t.due.includes(' ')) {
        // Due today (date only, no time) — not overdue yet
        continue;
    }
    if (t.isOverdue || t.due) {
        console.log(JSON.stringify({ id: t.id, title: t.title, due: t.due, priority: t.priority }));
    }
}
" | while IFS= read -r line; do
    TASK_ID=$(echo "$line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).id)")
    TASK_TITLE=$(echo "$line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).title)")
    TASK_DUE=$(echo "$line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).due || '')")
    TASK_PRIORITY=$(echo "$line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).priority || 'medium')")

    # Skip if already notified today
    TODAY=$(date +%Y-%m-%d)
    if grep -q "^${TASK_ID}|${TODAY}$" "$NOTIFIED_FILE" 2>/dev/null; then
        continue
    fi

    # Build the reminder with the task's actual due date and high priority
    REMINDER_TITLE="[Overdue] $TASK_TITLE"
    NOTES="Priority: $TASK_PRIORITY | Due: $TASK_DUE | Task ID: $TASK_ID"

    # Set due to right now so the alarm fires immediately.
    # The task is already overdue — the original due date is in the past.
    # The point is to notify NOW, not replay the old deadline.
    DUE_ARGS="--due $(date +%Y-%m-%d) $(date +%H:%M)"

    if $DRY_RUN; then
        echo "Would create reminder: $REMINDER_TITLE ($NOTES) [due: $TASK_DUE, priority: high]"
    else
        "$REMINDERS_SH" add "$REMINDER_TITLE" $DUE_ARGS --priority high --notes "$NOTES" > /dev/null 2>&1 || true
        # Track that we notified for this task today
        echo "${TASK_ID}|${TODAY}" >> "$NOTIFIED_FILE"
    fi
done

# Clean up old tracking entries (keep last 7 days)
if [ -f "$NOTIFIED_FILE" ]; then
    CUTOFF=$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d "7 days ago" +%Y-%m-%d 2>/dev/null || echo "")
    if [ -n "$CUTOFF" ]; then
        awk -F'|' -v cutoff="$CUTOFF" '$2 >= cutoff' "$NOTIFIED_FILE" > "$NOTIFIED_FILE.tmp" && mv "$NOTIFIED_FILE.tmp" "$NOTIFIED_FILE"
    fi
fi
